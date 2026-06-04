const express = require('express')
const crypto = require('crypto')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')

const router = express.Router()

const REQUIRED_TASKS = 3
const REQUIRED_COMPLETED_TASKS = 2

const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || ''
const TELEGRAM_MINI_APP_NAME = process.env.TELEGRAM_MINI_APP_NAME || ''

function createReferralCode() {
  return crypto.randomBytes(8).toString('base64url')
}

function buildInviteLink(code) {
  if (!TELEGRAM_BOT_USERNAME || !code) return ''

  const payload = `ref_${code}`

  if (TELEGRAM_MINI_APP_NAME) {
    return `https://t.me/${TELEGRAM_BOT_USERNAME}/${TELEGRAM_MINI_APP_NAME}?startapp=${payload}`
  }

  return `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${payload}`
}

function cleanReferralCode(value) {
  const text = String(value || '').trim()

  if (!text) return ''

  return text.replace(/^ref_/, '')
}

function isTaskCompleted(task) {
  if (task.completed) return true

  const done = Array.isArray(task.done) ? task.done : []

  return done.length > 0
}

async function getOrCreateReferralCode(userId) {
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, referral_code')
    .eq('id', userId)
    .single()

  if (userError || !user) {
    throw new Error('USER_NOT_FOUND')
  }

  if (user.referral_code) {
    return user.referral_code
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = createReferralCode()

    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({
        referral_code: code,
      })
      .eq('id', userId)
      .select('referral_code')
      .single()

    if (!updateError && updatedUser?.referral_code) {
      return updatedUser.referral_code
    }
  }

  throw new Error('REFERRAL_CODE_CREATE_FAILED')
}

async function getUserBasic(userId) {
  const { data: user, error } = await supabase
    .from('users')
    .select(
      'id, telegram_id, username, app_nickname, first_name, display_name, friend_invite_balance'
    )
    .eq('id', userId)
    .single()

  if (error || !user) return null

  return user
}

async function getInvitedUserProgress(invitedUserId) {
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, completed, done')
    .eq('user_id', invitedUserId)

  if (error) {
    throw error
  }

  const totalTasks = Array.isArray(tasks) ? tasks.length : 0

  const completedTasks = Array.isArray(tasks)
    ? tasks.filter((task) => isTaskCompleted(task)).length
    : 0

  return {
    totalTasks,
    completedTasks,
    qualified:
      totalTasks >= REQUIRED_TASKS &&
      completedTasks >= REQUIRED_COMPLETED_TASKS,
  }
}

async function refreshReferralQualificationForInviter(inviterUserId) {
  const { data: referrals, error } = await supabase
    .from('user_referrals')
    .select('id, invited_user_id, status')
    .eq('inviter_user_id', inviterUserId)
    .eq('status', 'pending')

  if (error) {
    throw error
  }

  for (const referral of referrals || []) {
    const progress = await getInvitedUserProgress(referral.invited_user_id)

    const updatePayload = {
      total_tasks: progress.totalTasks,
      completed_tasks: progress.completedTasks,
      updated_at: new Date().toISOString(),
    }

    if (!progress.qualified) {
      await supabase
        .from('user_referrals')
        .update(updatePayload)
        .eq('id', referral.id)

      continue
    }

    const { data: updatedRows, error: updateError } = await supabase
      .from('user_referrals')
      .update({
        ...updatePayload,
        status: 'qualified',
        qualified_at: new Date().toISOString(),
      })
      .eq('id', referral.id)
      .eq('status', 'pending')
      .select('id')

    if (updateError) {
      throw updateError
    }

    if (updatedRows && updatedRows.length > 0) {
      await supabase.rpc('increment_friend_invite_balance', {
        p_user_id: inviterUserId,
        p_amount: 1,
      })
    }
  }
}

async function getReferralList(inviterUserId) {
  const { data: referrals, error } = await supabase
    .from('user_referrals')
    .select(
      `
      id,
      invited_user_id,
      referral_code,
      status,
      total_tasks,
      completed_tasks,
      invited_at,
      qualified_at,
      updated_at
      `
    )
    .eq('inviter_user_id', inviterUserId)
    .order('invited_at', { ascending: false })

  if (error) {
    throw error
  }

  const invitedUserIds = (referrals || [])
    .map((item) => item.invited_user_id)
    .filter(Boolean)

  let usersMap = {}

  if (invitedUserIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, username, app_nickname, first_name, display_name')
      .in('id', invitedUserIds)

    if (usersError) {
      throw usersError
    }

    usersMap = Object.fromEntries(
      (users || []).map((user) => [
        user.id,
        {
          id: user.id,
          name:
            user.display_name ||
            user.first_name ||
            user.app_nickname ||
            user.username ||
            'User',
          nickname: user.app_nickname || user.username || '',
        },
      ])
    )
  }

  return (referrals || []).map((referral) => ({
    id: referral.id,
    invitedUserId: referral.invited_user_id,
    user: usersMap[referral.invited_user_id] || null,
    status: referral.status,
    totalTasks: referral.total_tasks || 0,
    completedTasks: referral.completed_tasks || 0,
    invitedAt: referral.invited_at,
    qualifiedAt: referral.qualified_at,
  }))
}

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const referralCode = await getOrCreateReferralCode(userId)

    await refreshReferralQualificationForInviter(userId)

    const user = await getUserBasic(userId)

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
      })
    }

    const invitedUsers = await getReferralList(userId)

    const qualifiedCount = invitedUsers.filter(
      (item) => item.status === 'qualified'
    ).length

    const pendingCount = invitedUsers.filter(
      (item) => item.status === 'pending'
    ).length

    res.json({
      success: true,
      referral: {
        referralCode,
        inviteLink: buildInviteLink(referralCode),

        friendInviteBalance: Number(user.friend_invite_balance || 0),

        invitedUsers,
        qualifiedCount,
        pendingCount,

        conditions: {
          telegramOnly: true,
          requiredTasks: REQUIRED_TASKS,
          requiredCompletedTasks: REQUIRED_COMPLETED_TASKS,
        },
      },
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'REFERRAL_LOAD_FAILED',
    })
  }
})

router.post('/attach', authMiddleware, async (req, res) => {
  try {
    const invitedUserId = req.user.id
    const referralCode = cleanReferralCode(req.body?.referralCode)

    if (!referralCode) {
      return res.status(400).json({
        success: false,
        error: 'REFERRAL_CODE_REQUIRED',
      })
    }

    const invitedUser = await getUserBasic(invitedUserId)

    if (!invitedUser) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
      })
    }

    if (!invitedUser.telegram_id) {
      return res.status(400).json({
        success: false,
        error: 'TELEGRAM_ONLY_REFERRAL',
      })
    }

    const { data: inviter, error: inviterError } = await supabase
      .from('users')
      .select('id, referral_code')
      .eq('referral_code', referralCode)
      .single()

    if (inviterError || !inviter) {
      return res.status(404).json({
        success: false,
        error: 'REFERRAL_CODE_NOT_FOUND',
      })
    }

    if (inviter.id === invitedUserId) {
      return res.status(400).json({
        success: false,
        error: 'CANNOT_INVITE_YOURSELF',
      })
    }

    const { data: existingReferral } = await supabase
      .from('user_referrals')
      .select('id, inviter_user_id, status')
      .eq('invited_user_id', invitedUserId)
      .maybeSingle()

    if (existingReferral) {
      return res.json({
        success: true,
        alreadyAttached: true,
        referral: existingReferral,
      })
    }

    const progress = await getInvitedUserProgress(invitedUserId)

    const initialStatus = progress.qualified ? 'qualified' : 'pending'

    const { data: referral, error: insertError } = await supabase
      .from('user_referrals')
      .insert({
        inviter_user_id: inviter.id,
        invited_user_id: invitedUserId,
        referral_code: referralCode,

        status: initialStatus,
        total_tasks: progress.totalTasks,
        completed_tasks: progress.completedTasks,
        qualified_at: progress.qualified ? new Date().toISOString() : null,
      })
      .select()
      .single()

    if (insertError) {
      return res.status(500).json({
        success: false,
        error: insertError.message,
      })
    }

    if (progress.qualified) {
      await supabase.rpc('increment_friend_invite_balance', {
        p_user_id: inviter.id,
        p_amount: 1,
      })
    }

    res.json({
      success: true,
      alreadyAttached: false,
      referral,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'REFERRAL_ATTACH_FAILED',
    })
  }
})

router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    await refreshReferralQualificationForInviter(userId)

    const user = await getUserBasic(userId)
    const referralCode = await getOrCreateReferralCode(userId)
    const invitedUsers = await getReferralList(userId)

    res.json({
      success: true,
      referral: {
        referralCode,
        inviteLink: buildInviteLink(referralCode),
        friendInviteBalance: Number(user?.friend_invite_balance || 0),
        invitedUsers,
        qualifiedCount: invitedUsers.filter(
          (item) => item.status === 'qualified'
        ).length,
        pendingCount: invitedUsers.filter(
          (item) => item.status === 'pending'
        ).length,
        conditions: {
          telegramOnly: true,
          requiredTasks: REQUIRED_TASKS,
          requiredCompletedTasks: REQUIRED_COMPLETED_TASKS,
        },
      },
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'REFERRAL_REFRESH_FAILED',
    })
  }
})

module.exports = router