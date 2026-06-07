const { supabase } = require('./supabaseClient')
const { sendTelegramMessage } = require('./telegram.service')

const NOTIFICATION_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SENT: 'sent',
  FAILED: 'failed',
}

const TASK_START_TYPE = 'task_start'
const TASK_END_TYPE = 'task_end'
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

  const text = String(timeText).trim()

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

function parseTaskTimeRange(timeText) {
  if (!timeText) {
    return {
      startTime: '',
      endTime: '',
    }
  }

  const text = String(timeText).trim()
  const parts = text.split('-').map((item) => item.trim())

  return {
    startTime: parts[0] || '',
    endTime:
      parts[1] && parts[1] !== '--:--' && parts[1] !== '00:00'
        ? parts[1]
        : '',
  }
}

function formatTimeParts(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
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

function getDateInTimezone(dateInput, timeZone = DEFAULT_TIMEZONE) {
  const date = new Date(dateInput)

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date)

  const values = {}

  parts.forEach((part) => {
    if (part.type !== 'literal') {
      values[part.type] = part.value
    }
  })

  return `${values.day}/${values.month}/${values.year}`
}

function isTaskDoneOnDate(task, dateText) {
  const done = Array.isArray(task.done) ? task.done : []
  return done.includes(dateText)
}

function isActiveProUser(user) {
  const expiresAt = user?.pro_expires_at || null

  if (!user?.pro_subscription) return false

  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    return false
  }

  return true
}

function getNextNotificationSendAt({
  task,
  timeText,
  userTimezone,
  notificationType,
}) {
  if (!timeText) return null
  if (task.frozen || task.completed) return null

  const repeat = Array.isArray(task.repeat) ? task.repeat : []
  const now = new Date()

  if (repeat.length === 0) {
    if (!task.date) return null

    const sendAt = zonedDateTimeToUtc({
      dateText: task.date,
      timeText,
      timeZone: userTimezone,
    })

    if (!sendAt) return null
    if (sendAt.getTime() <= now.getTime()) return null

    const doneDate = getDateInTimezone(sendAt, userTimezone)

    if (notificationType === TASK_END_TYPE && isTaskDoneOnDate(task, doneDate)) {
      return null
    }

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
      timeText,
      timeZone: userTimezone,
    })

    if (!sendAt || sendAt.getTime() <= now.getTime()) continue

    const doneDate = getDateInTimezone(sendAt, userTimezone)

    if (notificationType === TASK_END_TYPE && isTaskDoneOnDate(task, doneDate)) {
      continue
    }

    return sendAt
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
      done,
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
      notify_task_start,
      notify_task_end,
      pro_subscription,
      pro_expires_at,
      pro_plan
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

  const userTimezone = user.timezone || DEFAULT_TIMEZONE
  const isPro = isActiveProUser(user)
  const { startTime, endTime } = parseTaskTimeRange(task.time)

  const insertRows = []

  if (user.notify_task_start !== false && startTime) {
    const sendAt = getNextNotificationSendAt({
      task,
      timeText: startTime,
      userTimezone,
      notificationType: TASK_START_TYPE,
    })

    if (sendAt) {
      insertRows.push({
        task_id: task.id,
        user_id: task.user_id,
        notification_type: TASK_START_TYPE,
        send_at: sendAt.toISOString(),
        status: NOTIFICATION_STATUS.PENDING,
      })
    }
  }

  if (isPro && user.notify_task_end !== false && endTime) {
    const sendAt = getNextNotificationSendAt({
      task,
      timeText: endTime,
      userTimezone,
      notificationType: TASK_END_TYPE,
    })

    if (sendAt) {
      insertRows.push({
        task_id: task.id,
        user_id: task.user_id,
        notification_type: TASK_END_TYPE,
        send_at: sendAt.toISOString(),
        status: NOTIFICATION_STATUS.PENDING,
      })
    }
  }

  if (insertRows.length === 0) {
    return {
      success: false,
      reason: 'NO_NOTIFICATION_TO_CREATE',
      isPro,
      task,
    }
  }

  const { data: insertedNotifications, error: insertError } = await supabase
    .from('task_notifications')
    .insert(insertRows)
    .select()

  if (insertError) {
    return {
      success: false,
      reason: 'INSERT_NOTIFICATION_FAILED',
      error: insertError.message,
    }
  }

  return {
    success: true,
    reason: 'TASK_NOTIFICATIONS_CREATED',
    notifications: insertedNotifications || [],
  }
}

function getTaskStartMessage({ task, user }) {
  if (user.language === 'ru') {
    return `⏰ Задача начинается: ${task.title}`
  }

  return `⏰ Task starts now: ${task.title}`
}

function getTaskEndMessage({ task, user }) {
  if (user.language === 'ru') {
    return `⏳ Время задачи закончилось: ${task.title}`
  }

  return `⏳ Task time ended: ${task.title}`
}

function buildStartReplyMarkup({ task, doneDate, user }) {
  return {
    inline_keyboard: [
      [
        {
          text: user.language === 'ru' ? '✅ Выполнено' : '✅ Done',
          callback_data: `task_done:${task.id}:${doneDate}`,
        },
      ],
    ],
  }
}

function buildEndReplyMarkup({ task, doneDate, user }) {
  return {
    inline_keyboard: [
      [
        {
          text: user.language === 'ru' ? '✅ Выполнено' : '✅ Done',
          callback_data: `task_done:${task.id}:${doneDate}`,
        },
      ],
      [
        {
          text:
            user.language === 'ru'
              ? '➕ Продлить на 15 мин'
              : '➕ Extend 15 min',
          callback_data: `task_extend:${task.id}`,
        },
      ],
    ],
  }
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
  await markNotification(notification.id, {
    status: NOTIFICATION_STATUS.PROCESSING,
  })

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('id, user_id, title, date, time, repeat, done, frozen, completed')
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
      timezone,
      notifications_enabled,
      notify_task_start,
      notify_task_end,
      pro_subscription,
      pro_expires_at,
      pro_plan
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

  const doneDate = getDateInTimezone(
    notification.send_at || new Date(),
    user.timezone || DEFAULT_TIMEZONE
  )

  if (isTaskDoneOnDate(task, doneDate)) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: 'TASK_ALREADY_DONE',
    })

    await rebuildTaskNotifications(task.id)
    return
  }

  if (
    !user.telegram_id ||
    user.notifications_enabled === false ||
    task.frozen ||
    task.completed
  ) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: 'NOTIFICATION_NOT_ALLOWED',
    })

    return
  }

  const isPro = isActiveProUser(user)

  if (notification.notification_type === TASK_END_TYPE && !isPro) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: 'PRO_REQUIRED_FOR_TASK_END_NOTIFICATION',
    })

    return
  }

  if (
    notification.notification_type === TASK_START_TYPE &&
    user.notify_task_start === false
  ) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: 'TASK_START_NOTIFICATIONS_DISABLED',
    })

    return
  }

  if (
    notification.notification_type === TASK_END_TYPE &&
    user.notify_task_end === false
  ) {
    await markNotification(notification.id, {
      status: NOTIFICATION_STATUS.FAILED,
      error: 'TASK_END_NOTIFICATIONS_DISABLED',
    })

    return
  }

  try {
    const isEndNotification = notification.notification_type === TASK_END_TYPE

    await sendTelegramMessage({
      chatId: user.telegram_id,
      text: isEndNotification
        ? getTaskEndMessage({ task, user })
        : getTaskStartMessage({ task, user }),
      replyMarkup: isEndNotification
        ? buildEndReplyMarkup({ task, doneDate, user })
        : buildStartReplyMarkup({ task, doneDate, user }),
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

function initNotificationScheduler() {
  if (schedulerInterval) {
    console.log('Notification scheduler already running')
    return
  }

  console.log('Notification scheduler init started')

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