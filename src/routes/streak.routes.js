const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')

const router = express.Router()

const CHECK_COOLDOWN_MS = 1500
const requestMemory = new Map()

function formatDate(dateObject) {
  const day = String(dateObject.getDate()).padStart(2, '0')
  const month = String(dateObject.getMonth() + 1).padStart(2, '0')
  const year = dateObject.getFullYear()

  return `${day}/${month}/${year}`
}

function getTodayDate() {
  return formatDate(new Date())
}

function getDateObjectFromString(dateString) {
  if (!dateString) return null

  const parts = String(dateString).split('/').map(Number)

  if (parts.length !== 3) return null

  const [day, month, year] = parts

  if (!day || !month || !year) return null

  const dateObject = new Date(year, month - 1, day)
  dateObject.setHours(0, 0, 0, 0)

  return dateObject
}

function getYesterdayDate(todayDate) {
  const todayObject = getDateObjectFromString(todayDate)

  if (!todayObject) return null

  todayObject.setDate(todayObject.getDate() - 1)

  return formatDate(todayObject)
}

function getDateDiffDays(fromDateText, toDateText) {
  const fromDate = getDateObjectFromString(fromDateText)
  const toDate = getDateObjectFromString(toDateText)

  if (!fromDate || !toDate) return null

  fromDate.setHours(0, 0, 0, 0)
  toDate.setHours(0, 0, 0, 0)

  const diffMs = toDate.getTime() - fromDate.getTime()

  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

function getWeekNameFromDate(dateObject) {
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

  return names[dateObject.getDay()]
}

function isTaskRepeatedOnDate(task, dateObject) {
  if (!Array.isArray(task.repeat) || task.repeat.length === 0) return false

  const dayName = getWeekNameFromDate(dateObject)

  return task.repeat.some((repeatItem) => {
    const value = String(repeatItem).toLowerCase().trim()

    return (
      value === dayName ||
      value === 'daily' ||
      value === 'everyday' ||
      value === 'every day'
    )
  })
}

function isFriendChallengeActiveOnDate(task, selectedDateObject) {
  const challengeType = task.challenge_type || task.challengeType

  if (challengeType !== 'friend') return false

  const challengeStatus = task.challenge_status || task.challengeStatus

  if (challengeStatus !== 'accepted') return false

  const startDate = task.start_date || task.startDate
  const endDate = task.end_date || task.endDate

  if (!startDate || !endDate) return false

  const startDateObject = getDateObjectFromString(startDate)
  const endDateObject = getDateObjectFromString(endDate)

  if (!startDateObject || !endDateObject) return false

  return (
    selectedDateObject >= startDateObject &&
    selectedDateObject <= endDateObject
  )
}

function isTaskActiveOnDate(task, dateString) {
  const selectedDateObject = getDateObjectFromString(dateString)

  if (!selectedDateObject) return false

  if (task.frozen) return false
  if (task.completed) return false

  const challengeType = task.challenge_type || task.challengeType

  if (challengeType === 'friend') {
    return isFriendChallengeActiveOnDate(task, selectedDateObject)
  }

  const taskDate = task.date || ''

  if (taskDate === dateString) return true

  if (!taskDate) return false

  const taskStartDate = getDateObjectFromString(taskDate)

  if (!taskStartDate) return false

  if (selectedDateObject < taskStartDate) return false

  return isTaskRepeatedOnDate(task, selectedDateObject)
}

function isMainTaskDoneOnDate(task, dateString) {
  const done = Array.isArray(task.done) ? task.done : []

  return done.includes(dateString)
}

function areSubtasksDone(task) {
  const subtasks = Array.isArray(task.subtask_arr)
    ? task.subtask_arr
    : Array.isArray(task.subtaskArr)
      ? task.subtaskArr
      : []

  if (subtasks.length === 0) return true

  return subtasks.every((subtask) =>
    Boolean(subtask.done || subtask.completed)
  )
}

function isTaskFullyDoneOnDate(task, dateString) {
  const mainDone = isMainTaskDoneOnDate(task, dateString)

  if (!mainDone) return false

  return areSubtasksDone(task)
}

function canRunStreakCheck(userId) {
  const now = Date.now()
  const lastRun = requestMemory.get(userId) || 0

  if (now - lastRun < CHECK_COOLDOWN_MS) {
    return false
  }

  requestMemory.set(userId, now)

  return true
}

async function getOrCreateStreak(userId) {
  const { data: existingStreak, error: findError } = await supabase
    .from('user_streaks')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (findError) {
    throw findError
  }

  if (existingStreak) return existingStreak

  const { data: createdStreak, error: insertError } = await supabase
    .from('user_streaks')
    .insert({
      user_id: userId,
      streak: 0,
      last_date: null,
      frozen: false,
    })
    .select()
    .single()

  if (insertError) {
    throw insertError
  }

  return createdStreak
}

async function getTodayTasks(userId, todayDate) {
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select(
      `
      id,
      user_id,
      title,
      date,
      repeat,
      done,
      subtask_arr,
      frozen,
      completed,
      challenge_type,
      challenge_status,
      start_date,
      end_date
      `
    )
    .eq('user_id', userId)

  if (error) {
    throw error
  }

  return (tasks || []).filter((task) => isTaskActiveOnDate(task, todayDate))
}

async function getTodayTasksProgress(userId) {
  const todayDate = getTodayDate()
  const todayTasks = await getTodayTasks(userId, todayDate)

  const completedTodayTasks = todayTasks.filter((task) =>
    isTaskFullyDoneOnDate(task, todayDate)
  )

  return {
    todayDate,
    totalTodayTasks: todayTasks.length,
    completedTodayTasks: completedTodayTasks.length,
    allTodayTasksDone:
      todayTasks.length > 0 && completedTodayTasks.length === todayTasks.length,
    todayTasks: todayTasks.map((task) => ({
      id: task.id,
      title: task.title,
      done: isTaskFullyDoneOnDate(task, todayDate),
    })),
  }
}

async function updateStreak(userId, patch) {
  const { data, error } = await supabase
    .from('user_streaks')
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

function serializeStreak(row) {
  return {
    userId: row.user_id,
    streak: Number(row.streak || 0),
    lastDate: row.last_date || null,
    frozen: Boolean(row.frozen),
  }
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const streakRow = await getOrCreateStreak(userId)

    res.json({
      success: true,
      streak: serializeStreak(streakRow),
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'STREAK_LOAD_FAILED',
    })
  }
})

router.post('/check', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    if (!canRunStreakCheck(userId)) {
      const currentStreak = await getOrCreateStreak(userId)
      const progress = await getTodayTasksProgress(userId)

      return res.json({
        success: true,
        skipped: true,
        action: 'RATE_LIMITED',
        ...progress,
        streak: serializeStreak(currentStreak),
      })
    }

    const currentStreak = await getOrCreateStreak(userId)

    const {
      todayDate,
      totalTodayTasks,
      completedTodayTasks,
      allTodayTasksDone,
      todayTasks,
    } = await getTodayTasksProgress(userId)

    const currentStreakNumber = Number(currentStreak.streak || 0)
    const lastDate = currentStreak.last_date || null
    const frozen = Boolean(currentStreak.frozen)

    let nextStreak = currentStreakNumber
    let nextLastDate = lastDate
    let nextFrozen = frozen
    let changed = false
    let action = 'NO_CHANGE'

    if (lastDate === todayDate && !allTodayTasksDone) {
      const yesterdayDate = getYesterdayDate(todayDate)
      const rolledBackStreak = Math.max(currentStreakNumber - 1, 0)

      nextStreak = rolledBackStreak
      nextLastDate = rolledBackStreak > 0 ? yesterdayDate : null
      nextFrozen = frozen
      changed = true
      action = 'TODAY_BECAME_INCOMPLETE'
    } else if (lastDate === todayDate && allTodayTasksDone) {
      action = 'ALREADY_COUNTED_TODAY'
    } else if (allTodayTasksDone) {
      const lastDateDiff = lastDate ? getDateDiffDays(lastDate, todayDate) : null

      if (!lastDate) {
        nextStreak = 1
        nextLastDate = todayDate
        nextFrozen = false
        changed = true
        action = 'FIRST_STREAK_DAY'
      } else if (lastDateDiff === 1) {
        nextStreak = currentStreakNumber + 1
        nextLastDate = todayDate
        nextFrozen = false
        changed = true
        action = 'STREAK_INCREASED'
      } else if (lastDateDiff === 2) {
        if (frozen) {
          nextStreak = currentStreakNumber + 1
          nextLastDate = todayDate
          nextFrozen = false
          changed = true
          action = 'FROZEN_USED_AND_STREAK_CONTINUED'
        } else {
          nextStreak = currentStreakNumber + 1
          nextLastDate = todayDate
          nextFrozen = false
          changed = true
          action = 'FREEZE_ACTIVATED_AND_STREAK_CONTINUED'
        }
      } else if (lastDateDiff && lastDateDiff > 2) {
        nextStreak = 1
        nextLastDate = todayDate
        nextFrozen = false
        changed = true
        action = 'STREAK_RESET_AND_STARTED_AGAIN'
      } else {
        nextStreak = 1
        nextLastDate = todayDate
        nextFrozen = false
        changed = true
        action = 'STREAK_STARTED'
      }
    } else {
      const lastDateDiff = lastDate ? getDateDiffDays(lastDate, todayDate) : null

      if (lastDateDiff === 2) {
        if (frozen) {
          nextStreak = 0
          nextLastDate = null
          nextFrozen = false
          changed = true
          action = 'STREAK_RESET_AFTER_SECOND_MISS'
        } else {
          nextStreak = currentStreakNumber
          nextLastDate = lastDate
          nextFrozen = true
          changed = true
          action = 'FREEZE_ACTIVATED'
        }
      } else if (lastDateDiff && lastDateDiff > 2) {
        nextStreak = 0
        nextLastDate = null
        nextFrozen = false
        changed = true
        action = 'STREAK_RESET_LONG_MISS'
      } else {
        action = 'TODAY_NOT_COMPLETE'
      }
    }

    const updatedStreak = changed
      ? await updateStreak(userId, {
          streak: nextStreak,
          last_date: nextLastDate,
          frozen: nextFrozen,
        })
      : currentStreak

    res.json({
      success: true,
      action,
      todayDate,
      allTodayTasksDone,
      totalTodayTasks,
      completedTodayTasks,
      todayTasks,
      streak: serializeStreak(updatedStreak),
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'STREAK_CHECK_FAILED',
    })
  }
})

module.exports = router