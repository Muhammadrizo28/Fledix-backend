const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')

const router = express.Router()

function getWeekStart(date) {
  const target = new Date(date)
  const day = target.getDay()
  const diff = target.getDate() - day + (day === 0 ? -6 : 1)

  target.setDate(diff)
  target.setHours(0, 0, 0, 0)

  return target
}

function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()

  return `${day}/${month}/${year}`
}

async function getTaskMasterProgress(userId) {
  const { count, error } = await supabase
    .from('task_completion_events')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('user_id', userId)

  if (error) return 0

  return count || 0
}

async function getTeamDisciplineProgress(userId) {
  const { count, error } = await supabase
    .from('task_completion_events')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('user_id', userId)
    .eq('task_type', 'friend_challenge')

  if (error) return 0

  return count || 0
}

async function getPerfectWeekProgress(userId) {
  const weekStart = getWeekStart(new Date())

  const weekDates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart)
    date.setDate(weekStart.getDate() + index)

    return formatDate(date)
  })

  const { data, error } = await supabase
    .from('task_completion_events')
    .select('completion_date')
    .eq('user_id', userId)
    .in('completion_date', weekDates)

  if (error || !Array.isArray(data)) return 0

  const uniqueDays = new Set(data.map((item) => item.completion_date))

  return uniqueDays.size
}

async function getChallengeCurrent(userId, challengeId) {
  if (challengeId === 'task_master') {
    return getTaskMasterProgress(userId)
  }

  if (challengeId === 'perfect_week') {
    return getPerfectWeekProgress(userId)
  }

  if (challengeId === 'team_discipline') {
    return getTeamDisciplineProgress(userId)
  }

  return 0
}

function normalizeChallenge(template, current, claim) {
  const target = Number(template.target || 0)
  const safeCurrent = Math.min(Number(current || 0), target)

  return {
    id: template.id,
    mode: template.mode,

    title: template.title || '',
    desc: template.description || '',

    current: safeCurrent,
    target,
    points: Number(template.points || 0),

    iconKey: template.icon_key || 'dart',

    completed: target > 0 && safeCurrent >= target,
    claimed: Boolean(claim),
  }
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const { data: templates, error: templatesError } = await supabase
      .from('challenge_templates')
      .select('*')
      .eq('active', true)
      .order('sort_order', { ascending: true })

    if (templatesError) {
      return res.status(500).json({
        success: false,
        error: templatesError.message,
      })
    }

    const { data: claims, error: claimsError } = await supabase
      .from('user_challenge_claims')
      .select('*')
      .eq('user_id', userId)

    if (claimsError) {
      return res.status(500).json({
        success: false,
        error: claimsError.message,
      })
    }

    const claimsMap = {}

    ;(claims || []).forEach((claim) => {
      claimsMap[claim.challenge_id] = claim
    })

    const challenges = []

    for (const template of templates || []) {
      const current = await getChallengeCurrent(userId, template.id)

      challenges.push(
        normalizeChallenge(template, current, claimsMap[template.id])
      )
    }

    res.json({
      success: true,
      soloChallenges: challenges.filter((item) => item.mode === 'solo'),
      friendsChallenges: challenges.filter((item) => item.mode === 'friends'),
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    })
  }
})

router.post('/:challengeId/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { challengeId } = req.params

    const { data: template, error: templateError } = await supabase
      .from('challenge_templates')
      .select('*')
      .eq('id', challengeId)
      .eq('active', true)
      .single()

    if (templateError || !template) {
      return res.status(404).json({
        success: false,
        error: 'CHALLENGE_NOT_FOUND',
      })
    }

    const current = await getChallengeCurrent(userId, challengeId)
    const target = Number(template.target || 0)

    if (current < target) {
      return res.status(400).json({
        success: false,
        error: 'CHALLENGE_NOT_COMPLETED',
      })
    }

    const rewardPoints = Number(template.points || 0)

    const { data: insertedClaim, error: claimInsertError } = await supabase
      .from('user_challenge_claims')
      .insert({
        user_id: userId,
        challenge_id: challengeId,
        reward_points: rewardPoints,
      })
      .select()
      .single()

    if (claimInsertError) {
      return res.status(400).json({
        success: false,
        error: 'REWARD_ALREADY_CLAIMED',
      })
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, axion')
      .eq('id', userId)
      .single()

    if (userError || !user) {
      await supabase
        .from('user_challenge_claims')
        .delete()
        .eq('user_id', userId)
        .eq('challenge_id', challengeId)

      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
      })
    }

    const previousAxion = Number(user.axion || 0)
    const nextAxion = previousAxion + rewardPoints

    const { error: axionError } = await supabase
      .from('users')
      .update({
        axion: nextAxion,
      })
      .eq('id', userId)

    if (axionError) {
      await supabase
        .from('user_challenge_claims')
        .delete()
        .eq('user_id', userId)
        .eq('challenge_id', challengeId)

      return res.status(500).json({
        success: false,
        error: axionError.message,
      })
    }

    res.json({
      success: true,
      axion: nextAxion,
      points: rewardPoints,
      claim: insertedClaim,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    })
  }
})

module.exports = router