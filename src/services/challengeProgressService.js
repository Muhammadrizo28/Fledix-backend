const { supabase } = require('./supabaseClient')

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

async function recordTaskCompletionEvent({
  userId,
  taskId,
  completionDate,
  taskType = 'regular',
  source = 'task_checkbox',
}) {
  if (!userId || !taskId || !completionDate) {
    return {
      success: false,
      error: 'INVALID_COMPLETION_EVENT_DATA',
    }
  }

  const { data, error } = await supabase
    .from('task_completion_events')
    .upsert(
      {
        user_id: userId,
        task_id: taskId,
        completion_date: completionDate,
        task_type: taskType,
        source,
      },
      {
        onConflict: 'user_id,task_id,completion_date',
        ignoreDuplicates: true,
      }
    )
    .select()
    .maybeSingle()

  if (error) {
    return {
      success: false,
      error: error.message,
    }
  }

  return {
    success: true,
    event: data || null,
  }
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

async function getChallengeProgressValue(userId, challengeId) {
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

async function getUserChallenges(userId) {
  const { data: templates, error: templatesError } = await supabase
    .from('challenge_templates')
    .select('*')
    .eq('active', true)
    .order('sort_order', { ascending: true })

  if (templatesError) {
    throw new Error(templatesError.message)
  }

  const { data: claims, error: claimsError } = await supabase
    .from('user_challenge_claims')
    .select('*')
    .eq('user_id', userId)

  if (claimsError) {
    throw new Error(claimsError.message)
  }

  const claimsMap = {}

  ;(claims || []).forEach((claim) => {
    claimsMap[claim.challenge_id] = claim
  })

  const challenges = []

  for (const template of templates || []) {
    const current = await getChallengeProgressValue(userId, template.id)

    challenges.push(
      normalizeChallenge(template, current, claimsMap[template.id])
    )
  }

  return {
    soloChallenges: challenges.filter((item) => item.mode === 'solo'),
    friendsChallenges: challenges.filter((item) => item.mode === 'friends'),
  }
}

async function claimChallengeReward(userId, challengeId) {
  const { data: template, error: templateError } = await supabase
    .from('challenge_templates')
    .select('*')
    .eq('id', challengeId)
    .eq('active', true)
    .single()

  if (templateError || !template) {
    return {
      success: false,
      error: 'CHALLENGE_NOT_FOUND',
    }
  }

  const current = await getChallengeProgressValue(userId, challengeId)
  const target = Number(template.target || 0)

  if (current < target) {
    return {
      success: false,
      error: 'CHALLENGE_NOT_COMPLETED',
    }
  }

  const rewardPoints = Number(template.points || 0)

  const { data: insertedClaim, error: claimError } = await supabase
    .from('user_challenge_claims')
    .insert({
      user_id: userId,
      challenge_id: challengeId,
      reward_points: rewardPoints,
    })
    .select()
    .single()

  if (claimError) {
    return {
      success: false,
      error: 'REWARD_ALREADY_CLAIMED',
    }
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

    return {
      success: false,
      error: 'USER_NOT_FOUND',
    }
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

    return {
      success: false,
      error: axionError.message,
    }
  }

  return {
    success: true,
    axion: nextAxion,
    points: rewardPoints,
    claim: insertedClaim,
  }
}

module.exports = {
  recordTaskCompletionEvent,
  getTaskMasterProgress,
  getPerfectWeekProgress,
  getTeamDisciplineProgress,
  getChallengeProgressValue,
  getUserChallenges,
  claimChallengeReward,
}