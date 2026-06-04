const { DateTime } = require('luxon')
const { supabase } = require('./supabaseClient')
const LOOKAHEAD_DAYS = 30

const DAY_CODES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parseTimeRange(time) {
  if (!time || typeof time !== 'string') {
    return {
      startTime: '',
      endTime: '',
    }
  }

  const parts = time.split(/\s*-\s*/)

  const startTime = parts[0]?.trim() || ''
  const endTime = parts[1]?.trim() || ''

  const isValid = (value) => /^\d{2}:\d{2}$/.test(value)

  return {
    startTime: isValid(startTime) ? startTime : '',
    endTime: isValid(endTime) ? endTime : '',
  }
}

function parseDate(dateString, timezone) {
  if (!dateString) return null

  const date = DateTime.fromFormat(dateString, 'dd/MM/yyyy', {
    zone: timezone,
  })

  if (!date.isValid) return null

  return date.startOf('day')
}

function buildSendAt({ dateString, timeString, timezone }) {
  const dateTime = DateTime.fromFormat(
    `${dateString} ${timeString}`,
    'dd/MM/yyyy HH:mm',
    {
      zone: timezone,
    }
  )

  if (!dateTime.isValid) return null

  return dateTime.toUTC().toISO()
}

function isDailyRepeat(repeat) {
  return repeat.some((item) => {
    const value = String(item).toLowerCase()

    return (
      value === 'daily' ||
      value === 'everyday' ||
      value === 'every day'
    )
  })
}

function isRepeatOnDate(repeat, date) {
  if (!Array.isArray(repeat) || repeat.length === 0) return false

  if (isDailyRepeat(repeat)) return true

  const dayCode = DAY_CODES[date.weekday % 7].toLowerCase()

  return repeat.some((item) => {
    return String(item).toLowerCase() === dayCode
  })
}

function getUpcomingTaskDates(task, timezone) {
  const taskDate = task.date || task.startDate || task.start_date || ''
  const repeat = Array.isArray(task.repeat) ? task.repeat : []

  const startDate = parseDate(taskDate, timezone)

  if (!startDate) return []

  if (repeat.length === 0) {
    return [startDate.toFormat('dd/MM/yyyy')]
  }

  const today = DateTime.now().setZone(timezone).startOf('day')
  const dates = []

  for (let i = 0; i <= LOOKAHEAD_DAYS; i += 1) {
    const currentDate = today.plus({ days: i })

    if (currentDate < startDate) continue

    if (isRepeatOnDate(repeat, currentDate)) {
      dates.push(currentDate.toFormat('dd/MM/yyyy'))
    }
  }

  return dates
}

function getNotificationText({ type, task, user }) {
  const language = user.language || 'en'
  const title = task.title || 'Task'

  if (language === 'ru') {
    if (type === 'task_start') {
      return `🔔 Задача начинается:\n<b>${title}</b>`
    }

    if (type === 'task_end') {
      return `⏰ Задача закончилась:\n<b>${title}</b>`
    }

    if (type === 'subscription_end') {
      return `👑 Твоя Pro подписка скоро закончится.`
    }
  }

  if (type === 'task_start') {
    return `🔔 Task starts now:\n<b>${title}</b>`
  }

  if (type === 'task_end') {
    return `⏰ Task ended:\n<b>${title}</b>`
  }

  if (type === 'subscription_end') {
    return `👑 Your Pro subscription is ending soon.`
  }

  return title
}

async function clearPendingTaskNotifications(taskId) {
  if (!taskId) return

  await supabase
    .from('notifications')
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('task_id', taskId)
    .eq('status', 'pending')
    .is('sent_at', null)
}

async function rebuildTaskNotifications(taskId) {
  if (!taskId) return

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .single()

  if (taskError || !task) {
    console.error('Task notification rebuild task load error:', taskError)
    return
  }

  const userId = task.user_id || task.userId

  if (!userId) return

  const { data: user, error: userError } = await supabase
    .from('users')
    .select(
      'id, telegram_id, timezone, language, notifications_enabled, notify_task_start, notify_task_end'
    )
    .eq('id', userId)
    .single()

  if (userError || !user) {
    console.error('Task notification rebuild user load error:', userError)
    return
  }

  await clearPendingTaskNotifications(taskId)

  if (!user.telegram_id) return
  if (!user.notifications_enabled) return
  if (task.frozen || task.completed) return

  const timezone = user.timezone || 'Europe/London'

  const { startTime, endTime } = parseTimeRange(task.time)

  if (!startTime && !endTime) return

  const dates = getUpcomingTaskDates(task, timezone)

  if (dates.length === 0) return

  const nowIso = DateTime.utc().toISO()
  const rows = []

  for (const dateString of dates) {
    if (startTime && user.notify_task_start !== false) {
      const sendAt = buildSendAt({
        dateString,
        timeString: startTime,
        timezone,
      })

      if (sendAt && sendAt > nowIso) {
        rows.push({
          user_id: user.id,
          telegram_id: user.telegram_id,
          task_id: task.id,
          type: 'task_start',
          title: task.title || 'Task',
          message: getNotificationText({
            type: 'task_start',
            task,
            user,
          }),
          send_at: sendAt,
          status: 'pending',
          dedupe_key: `task:${task.id}:start:${dateString}`,
        })
      }
    }

    if (endTime && user.notify_task_end !== false) {
      const sendAt = buildSendAt({
        dateString,
        timeString: endTime,
        timezone,
      })

      if (sendAt && sendAt > nowIso) {
        rows.push({
          user_id: user.id,
          telegram_id: user.telegram_id,
          task_id: task.id,
          type: 'task_end',
          title: task.title || 'Task',
          message: getNotificationText({
            type: 'task_end',
            task,
            user,
          }),
          send_at: sendAt,
          status: 'pending',
          dedupe_key: `task:${task.id}:end:${dateString}`,
        })
      }
    }
  }

  if (rows.length === 0) return

  const { error } = await supabase
    .from('notifications')
    .upsert(rows, {
      onConflict: 'dedupe_key',
      ignoreDuplicates: true,
    })

  if (error) {
    console.error('Notification upsert error:', error)
  }
}


async function rebuildSubscriptionNotifications(userId) {
  if (!userId) return

  const { data: user, error } = await supabase
    .from('users')
    .select(
      'id, telegram_id, timezone, language, notifications_enabled, notify_subscription_end, pro_subscription, pro_expires_at'
    )
    .eq('id', userId)
    .single()

  if (error || !user) return

  await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId)
    .eq('type', 'subscription_end')
    .eq('status', 'pending')
    .is('sent_at', null)

  if (!user.telegram_id) return
  if (!user.notifications_enabled) return
  if (!user.notify_subscription_end) return
  if (!user.pro_subscription) return
  if (!user.pro_expires_at) return

  const timezone = user.timezone || 'Europe/London'

  const endDate = DateTime.fromISO(user.pro_expires_at, {
    zone: 'utc',
  }).setZone(timezone)

  if (!endDate.isValid) return

  const now = DateTime.utc()

  if (endDate.toUTC() <= now) return

  const reminderOffsets = [
    {
      key: '3d',
      date: endDate.minus({ days: 3 }),
    },
    {
      key: '1d',
      date: endDate.minus({ days: 1 }),
    },
    {
      key: 'same-day',
      date: endDate,
    },
  ]

  const rows = []

  for (const item of reminderOffsets) {
    const sendAt = item.date.toUTC()

    if (sendAt <= now) continue

    const message =
      user.language === 'ru'
        ? `👑 Твоя Pro подписка заканчивается ${endDate.toFormat('dd/MM/yyyy')}.`
        : `👑 Your Pro subscription ends on ${endDate.toFormat('dd/MM/yyyy')}.`

    rows.push({
      user_id: user.id,
      telegram_id: user.telegram_id,
      task_id: null,
      type: 'subscription_end',
      title: 'Pro subscription',
      message,
      send_at: sendAt.toISO(),
      status: 'pending',
      dedupe_key: `subscription:${user.id}:${item.key}:${endDate.toISODate()}`,
    })
  }

  if (rows.length === 0) return

  const { error: insertError } = await supabase
    .from('notifications')
    .insert(rows)

  if (insertError) {
    console.error('Subscription notification insert error:', insertError)
  }
}

module.exports = {
  rebuildTaskNotifications,
  clearPendingTaskNotifications,
  rebuildSubscriptionNotifications,
}