const { supabase } = require('./supabaseClient')
const { sendTelegramMessage } = require('./telegram.service')

const NOTIFICATION_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SENT: 'sent',
  FAILED: 'failed',
}

const TASK_START_TYPE = 'task_start'
const DEFAULT_TIMEZONE = 'Europe/London'

let schedulerInterval = null
let isProcessing = false

function parseDateParts(dateText) {
  if (!dateText) return null

  const text = String(dateText).trim()

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
    const [day, month, year] = text.split('/').map(Number)
    return { day, month, year }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number)
    return { day, month, year }
  }

  return null
}

function parseTimeParts(timeText) {
  if (!timeText) return null

  const rawText = String(timeText).trim()

  // Берём только начало времени:
  // "09:37 - --:--" => "09:37"
  // "09:37 - 10:30" => "09:37"
  const text = rawText.split('-')[0].trim()

  const amPmMatch = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)

  if (amPmMatch) {
    let hour = Number(amPmMatch[1])
    const minute = Number(amPmMatch[2])
    const period = amPmMatch[3].toUpperCase()

    if (period === 'PM' && hour !== 12) hour += 12
    if (period === 'AM' && hour === 12) hour = 0

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

    return { hour, minute }
  }

  const normalMatch = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)

  if (!normalMatch) return null

  const hour = Number(normalMatch[1])
  const minute = Number(normalMatch[2])

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

  return { hour, minute }
}

function formatDate(dateObject) {
  const day = String(dateObject.getDate()).padStart(2, '0')
  const month = String(dateObject.getMonth() + 1).padStart(2, '0')
  const year = dateObject.getFullYear()

  return `${day}/${month}/${year}`
}

function getWeekName(dateObject) {
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  return names[dateObject.getDay()]
}

function isRepeatOnDate(repeat, dateObject) {
  if (!Array.isArray(repeat) || repeat.length === 0) return false

  const dayName = getWeekName(dateObject)

  return repeat.some((item) => {
    const value = String(item).toLowerCase().trim()

    return (
      value === dayName ||
      value === 'daily' ||
      value === 'everyday' ||
      value === 'every day'
    )
  })
}

function getTimeZoneOffsetMs(timeZone, dateObject) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(dateObject)

  const values = {}

  parts.forEach((part) => {
    if (part.type !== 'literal') {
      values[part.type] = part.value
    }
  })

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  )

  return asUtc - dateObject.getTime()
}

function zonedDateTimeToUtc({ dateText, timeText, timeZone }) {
  const dateParts = parseDateParts(dateText)
  const timeParts = parseTimeParts(timeText)

  if (!dateParts || !timeParts) return null

  const zone = timeZone || DEFAULT_TIMEZONE

  const utcGuess = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    0,
    0
  )

  const firstOffset = getTimeZoneOffsetMs(zone, new Date(utcGuess))
  const firstUtc = new Date(utcGuess - firstOffset)

  const secondOffset = getTimeZoneOffsetMs(zone, firstUtc)
  const finalUtc = new Date(utcGuess - secondOffset)

  if (Number.isNaN(finalUtc.getTime())) return null

  return finalUtc
}

function getNextStartSendAt(task, userTimezone) {
  if (!task?.time) return null
  if (task.frozen || task.completed) return null

  const repeat = Array.isArray(task.repeat) ? task.repeat : []
  const now = new Date()

  if (repeat.length === 0) {
    if (!task.date) return null

    const sendAt = zonedDateTimeToUtc({
      dateText: task.date,
      timeText: task.time,
      timeZone: userTimezone,
    })

    if (!sendAt) return null
    if (sendAt.getTime() <= now.getTime()) return null

    return sendAt
  }

  const startDateParts = parseDateParts(task.date)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  let startDate = today

  if (startDateParts) {
    startDate = new Date(
      startDateParts.year,
      startDateParts.month - 1,
      startDateParts.day
    )

    startDate.setHours(0, 0, 0, 0)

    if (startDate < today) {
      startDate = today
    }
  }

  for (let i = 0; i < 60; i += 1) {
    const candidate = new Date(startDate)
    candidate.setDate(startDate.getDate() + i)

    if (!isRepeatOnDate(repeat, candidate)) continue

    const candidateDateText = formatDate(candidate)

    const sendAt = zonedDateTimeToUtc({
      dateText: candidateDateText,
      timeText: task.time,
      timeZone: userTimezone,
    })

    if (sendAt && sendAt.getTime() > now.getTime()) {
      return sendAt
    }
  }

  return null
}

async function clearPendingTaskNotifications(taskId) {
  if (!taskId) return

  const { error } = await supabase
    .from('task_notifications')
    .delete()
    .eq('task_id', taskId)
    .eq('status', NOTIFICATION_STATUS.PENDING)

  if (error) {
    console.error('Clear pending task notifications error:', error.message)
  }
}

async function rebuildTaskNotifications(taskId) {
  if (!taskId) {
    return {
      success: false,
      reason: 'NO_TASK_ID',
    }
  }

  await clearPendingTaskNotifications(taskId)

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select(
      `
      id,
      user_id,
      title,
      date,
      time,
      repeat,
      frozen,
      completed,
      challenge_type
      `
    )
    .eq('id', taskId)
    .single()

  if (taskError || !task) {
    return {
      success: false,
      reason: 'TASK_NOT_FOUND',
      error: taskError?.message,
    }
  }

  if (!task.time) {
    return {
      success: false,
      reason: 'NO_TASK_TIME',
      task,
    }
  }

  const repeat = Array.isArray(task.repeat) ? task.repeat : []

  if (!task.date && repeat.length === 0) {
    return {
      success: false,
      reason: 'NO_TASK_DATE_AND_NO_REPEAT',
      task,
    }
  }

  if (task.frozen) {
    return {
      success: false,
      reason: 'TASK_FROZEN',
      task,
    }
  }

  if (task.completed) {
    return {
      success: false,
      reason: 'TASK_COMPLETED',
      task,
    }
  }

  if (task.challenge_type === 'friend') {
    return {
      success: false,
      reason: 'FRIEND_CHALLENGE_TASK',
      task,
    }
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select(
      `
      id,
      telegram_id,
      timezone,
      language,
      notifications_enabled,
      notify_task_start
      `
    )
    .eq('id', task.user_id)
    .single()

  if (userError || !user) {
    return {
      success: false,
      reason: 'USER_NOT_FOUND',
      error: userError?.message,
    }
  }

  if (!user.telegram_id) {
    return {
      success: false,
      reason: 'NO_TELEGRAM_ID',
      user,
    }
  }

  if (user.notifications_enabled === false) {
    return {
      success: false,
      reason: 'NOTIFICATIONS_DISABLED',
      user,
    }
  }

  if (user.notify_task_start === false) {
    return {
      success: false,
      reason: 'TASK_START_NOTIFICATIONS_DISABLED',
      user,
    }
  }

  const sendAt = getNextStartSendAt(task, user.timezone || DEFAULT_TIMEZONE)

  if (!sendAt) {
    return {
      success: false,
      reason: 'SEND_AT_NULL_DATE_TIME_INVALID_OR_PAST',
      task,
      timezone: user.timezone || DEFAULT_TIMEZONE,
    }
  }

  const { data: insertedNotification, error: insertError } = await supabase
    .from('task_notifications')
    .insert({
      task_id: task.id,
      user_id: task.user_id,
      notification_type: TASK_START_TYPE,
      send_at: sendAt.toISOString(),
      status: NOTIFICATION_STATUS.PENDING,
    })
    .select()
    .single()

  if (insertError) {
    return {
      success: false,
      reason: 'INSERT_NOTIFICATION_FAILED',
      error: insertError.message,
    }
  }

  return {
    success: true,
    reason: 'TASK_NOTIFICATION_CREATED',
    notification: insertedNotification,
  }
}

function getTaskStartMessage({ task, user }) {
  if (user.language === 'ru') {
    return `⏰ Задача начинается: ${task.title}`
  }

  return `⏰ Task starts now: ${task.title}`
}

async function markNotification(notificationId, patch) {
  const { error } = await supabase
    .from('task_notifications')
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq('id', notificationId)

  if (error) {
    console.error('Notification update error:', error.message)
  }
}

async function processNotification(notification) {
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('id, user_id, title, date, time, repeat, frozen, completed')
    .eq('id', notification.task_id)
    .single()

  if (taskError || !task) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: 'TASK_NOT_FOUND',
    })

    return
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select(
      `
      id,
      telegram_id,
      language,
      notifications_enabled,
      notify_task_start
      `
    )
    .eq('id', notification.user_id)
    .single()

  if (userError || !user) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: 'USER_NOT_FOUND',
    })

    return
  }

  if (
    !user.telegram_id ||
    user.notifications_enabled === false ||
    user.notify_task_start === false ||
    task.frozen ||
    task.completed
  ) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: 'NOTIFICATION_NOT_ALLOWED',
    })

    return
  }

  await markNotification(notification.id, {
    status: NOTIFICATION_STATUS.PROCESSING,
  })

  try {
    await sendTelegramMessage({
      chatId: user.telegram_id,
      text: getTaskStartMessage({ task, user }),
    })

    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.SENT,
      sent_at: new Date().toISOString(),
      error: null,
    })

    await rebuildTaskNotifications(task.id)
  } catch (error) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: error.message || 'TELEGRAM_SEND_FAILED',
    })
  }
}

async function processDueTaskNotifications() {
  if (isProcessing) return

  isProcessing = true

  try {
    const nowIso = new Date().toISOString()

    const { data: notifications, error } = await supabase
      .from('task_notifications')
      .select('id, task_id, user_id, notification_type, send_at, status')
      .eq('status', NOTIFICATION_STATUS.PENDING)
      .lte('send_at', nowIso)
      .order('send_at', { ascending: true })
      .limit(30)

    if (error) {
      throw error
    }

    for (const notification of notifications || []) {
      await processNotification(notification)
    }
  } catch (error) {
    console.error('Process task notifications error:', error.message)
  } finally {
    isProcessing = false
  }
}

async function rebuildAllPendingTaskNotifications() {
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id')
    .not('time', 'is', null)
    .neq('time', '')

  if (error) {
    console.error('Rebuild all task notifications error:', error.message)
    return
  }

  for (const task of tasks || []) {
    const result = await rebuildTaskNotifications(task.id)

    if (!result?.success) {
      console.log('Rebuild existing task notification skipped:', result)
    }
  }
}

function initNotificationScheduler() {
  if (schedulerInterval) return

  rebuildAllPendingTaskNotifications().catch((error) => {
    console.error('Initial task notification rebuild error:', error)
  })

  processDueTaskNotifications().catch((error) => {
    console.error('Initial task notification process error:', error)
  })

  schedulerInterval = setInterval(() => {
    processDueTaskNotifications()
  }, 30 * 1000)
}

module.exports = {
  initNotificationScheduler,
  rebuildTaskNotifications,
  clearPendingTaskNotifications,
  processDueTaskNotifications,
}