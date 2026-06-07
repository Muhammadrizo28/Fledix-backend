const express = require('express')

const { supabase } = require('../services/supabaseClient')

const {
  sendTelegramMessage,
  answerCallbackQuery,
  editTelegramMessageReplyMarkup,
  editTelegramMessageText,
} = require('../services/telegram.service')

const {
  recordTaskCompletionEvent,
} = require('../services/challengeProgressService')

const {
  rebuildTaskNotifications,
} = require('../services/notificationScheduler.service')

const router = express.Router()

function cleanReferralCode(value) {
  const text = String(value || '').trim()

  if (!text) return ''

  return text.replace(/^ref_/, '')
}

function getStartPayload(text) {
  const parts = String(text || '').trim().split(/\s+/)

  if (parts[0] !== '/start') return ''

  return parts[1] || ''
}

async function savePendingReferral({ telegramId, referralCode }) {
  if (!telegramId || !referralCode) return

  const cleanCode = cleanReferralCode(referralCode)

  if (!cleanCode) return

  const { error } = await supabase
    .from('pending_telegram_referrals')
    .upsert(
      {
        telegram_id: String(telegramId),
        referral_code: cleanCode,
        used: false,
        created_at: new Date().toISOString(),
      },
      {
        onConflict: 'telegram_id',
      }
    )

  if (error) {
    console.error('PENDING_REFERRAL_SAVE_ERROR:', error)
  }
}

function isActiveProUser(user) {
  const expiresAt = user?.pro_expires_at || null

  if (!user?.pro_subscription) return false

  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    return false
  }

  return true
}

function parseTaskTimeRange(timeText) {
  if (!timeText) {
    return {
      startTime: '',
      endTime: '',
    }
  }

  const parts = String(timeText)
    .trim()
    .split('-')
    .map((item) => item.trim())

  return {
    startTime: parts[0] || '',
    endTime:
      parts[1] && parts[1] !== '--:--' && parts[1] !== '00:00'
        ? parts[1]
        : '',
  }
}

function parseTimeParts(timeText) {
  if (!timeText) return null

  const match = String(timeText)
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/)

  if (!match) return null

  const hour = Number(match[1])
  const minute = Number(match[2])

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

  return {
    hour,
    minute,
  }
}

function addMinutesToTime(timeText, minutesToAdd) {
  const parts = parseTimeParts(timeText)

  if (!parts) return null

  const date = new Date()
  date.setHours(parts.hour, parts.minute, 0, 0)
  date.setMinutes(date.getMinutes() + minutesToAdd)

  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')

  return `${hour}:${minute}`
}

function buildExtendedTime(timeText, minutesToAdd = 15) {
  const { startTime, endTime } = parseTaskTimeRange(timeText)

  if (!startTime || !endTime) return null

  const nextEndTime = addMinutesToTime(endTime, minutesToAdd)

  if (!nextEndTime) return null

  return `${startTime} - ${nextEndTime}`
}

function parseCallbackData(data) {
  const text = String(data || '').trim()
  const parts = text.split(':')

  if (parts[0] === 'task_done' || parts[0] === 'done') {
    return {
      type: 'task_done',
      taskId: parts[1],
      doneDate: parts[2],
    }
  }

  if (parts[0] === 'task_extend' || parts[0] === 'extend') {
    return {
      type: 'task_extend',
      taskId: parts[1],
    }
  }

  if (parts[0] === 'focus_start') {
    return {
      type: 'focus_start',
      mode: parts[1] === 'break' ? 'break' : 'work',
      durationSeconds: Math.max(1, Number(parts[2] || 0)),
    }
  }

  return null
}

async function safeAnswerCallbackQuery({
  callbackQueryId,
  text = '',
  showAlert = false,
}) {
  if (!callbackQueryId) return

  try {
    await answerCallbackQuery({
      callbackQueryId,
      text,
      showAlert,
    })
  } catch (error) {
    console.error('ANSWER_CALLBACK_ERROR:', error.message)
  }
}

async function getUserByTelegramId(telegramId) {
  const { data: user, error } = await supabase
    .from('users')
    .select(
      `
      id,
      telegram_id,
      language,
      pro_subscription,
      pro_expires_at,
      pro_plan
      `
    )
    .eq('telegram_id', String(telegramId))
    .single()

  if (error || !user) {
    console.error('TELEGRAM_USER_NOT_FOUND:', {
      telegramId,
      error: error?.message,
    })

    return null
  }

  return user
}

async function editMessageAsProRequired({ chatId, messageId, user }) {
  if (!chatId || !messageId) return

  const text =
    user?.language === 'ru'
      ? '🔒 Для этого действия нужна Pro подписка.\n\nОткрой Fledix и перейди на Pro, чтобы использовать Telegram-кнопки.'
      : '🔒 Pro subscription is required for this action.\n\nOpen Fledix and upgrade to Pro to use Telegram buttons.'

  try {
    await editTelegramMessageText({
      chatId,
      messageId,
      text,
      replyMarkup: {
        inline_keyboard: [],
      },
    })

    return
  } catch (error) {
    console.error('EDIT PRO REQUIRED MESSAGE TEXT ERROR:', error.message)
  }

  try {
    await editTelegramMessageReplyMarkup({
      chatId,
      messageId,
      replyMarkup: {
        inline_keyboard: [],
      },
    })
  } catch (error) {
    console.error('EDIT PRO REQUIRED MESSAGE MARKUP ERROR:', error.message)
  }
}

async function handleStartMessage({ chatId, telegramId, text }) {
  const startPayload = getStartPayload(text)

  if (startPayload.startsWith('ref_')) {
    await savePendingReferral({
      telegramId,
      referralCode: startPayload,
    })

    await sendTelegramMessage({
      chatId,
      text:
        'Welcome to Fledix ✅\n\nReferral saved. Now open the app to continue.',
    })

    return
  }

  await sendTelegramMessage({
    chatId,
    text:
      'Welcome to Fledix ✅\n\nOpen the app and enable notifications to receive task reminders here.',
  })
}

async function editTaskMessageAsDone({ chatId, messageId, user, updatedTask }) {
  if (!chatId || !messageId || !updatedTask) return

  const text =
    user.language === 'ru'
      ? `✅ Выполнено: ${updatedTask.title}`
      : `✅ Done: ${updatedTask.title}`

  try {
    await editTelegramMessageText({
      chatId,
      messageId,
      text,
      replyMarkup: {
        inline_keyboard: [],
      },
    })

    return
  } catch (error) {
    console.error('EDIT TELEGRAM DONE MESSAGE TEXT ERROR:', error.message)
  }

  try {
    await editTelegramMessageReplyMarkup({
      chatId,
      messageId,
      replyMarkup: {
        inline_keyboard: [],
      },
    })
  } catch (error) {
    console.error('EDIT TELEGRAM DONE MESSAGE MARKUP ERROR:', error.message)
  }
}

async function handleTaskDoneCallback({ callbackQuery, parsed, user }) {
  const telegramId = String(callbackQuery.from?.id || '')
  const message = callbackQuery.message || {}
  const chatId = message.chat?.id
  const messageId = message.message_id

  console.log('TELEGRAM TASK DONE CALLBACK:', {
    telegramId,
    taskId: parsed.taskId,
    doneDate: parsed.doneDate,
  })

  const { taskId, doneDate } = parsed

  if (!taskId || !doneDate) {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text: 'Invalid task action.',
      }).catch(() => null)
    }

    return
  }

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('id, user_id, title, done, challenge_type')
    .eq('id', taskId)
    .eq('user_id', user.id)
    .single()

  if (taskError || !task) {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text: user.language === 'ru' ? 'Задача не найдена.' : 'Task not found.',
      }).catch(() => null)
    }

    return
  }

  if (task.challenge_type === 'friend') {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text:
          user.language === 'ru'
            ? 'Friend challenge нужно закрывать в приложении.'
            : 'Friend challenge must be completed in the app.',
      }).catch(() => null)
    }

    return
  }

  const currentDone = Array.isArray(task.done) ? task.done : []

  if (currentDone.includes(doneDate)) {
    await editTaskMessageAsDone({
      chatId,
      messageId,
      user,
      updatedTask: task,
    })

    return
  }

  const nextDone = [...currentDone, doneDate]

  const { data: updatedTask, error: updateError } = await supabase
    .from('tasks')
    .update({
      done: nextDone,
      updated_at: new Date().toISOString(),
    })
    .eq('id', task.id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (updateError || !updatedTask) {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text:
          user.language === 'ru'
            ? 'Не получилось обновить задачу.'
            : 'Failed to update task.',
      }).catch(() => null)
    }

    return
  }

  const eventResult = await recordTaskCompletionEvent({
    userId: user.id,
    taskId: updatedTask.id,
    completionDate: doneDate,
    taskType: 'regular',
    source: 'telegram_done_button',
  })

  if (!eventResult?.success) {
    console.error('Telegram done completion event error:', eventResult?.error)
  }

  await rebuildTaskNotifications(updatedTask.id)

  await editTaskMessageAsDone({
    chatId,
    messageId,
    user,
    updatedTask,
  })

  console.log('TELEGRAM TASK DONE SUCCESS:', {
    taskId: updatedTask.id,
    doneDate,
  })
}

async function handleTaskExtendCallback({ callbackQuery, parsed, user }) {
  const telegramId = String(callbackQuery.from?.id || '')

  const message = callbackQuery.message || {}
  const chatId = message.chat?.id

  console.log('TELEGRAM TASK EXTEND CALLBACK:', {
    telegramId,
    taskId: parsed.taskId,
  })

  const { taskId } = parsed

  if (!taskId) {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text: 'Invalid task action.',
      }).catch(() => null)
    }

    return
  }

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('id, user_id, title, time, challenge_type')
    .eq('id', taskId)
    .eq('user_id', user.id)
    .single()

  if (taskError || !task) {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text: user.language === 'ru' ? 'Задача не найдена.' : 'Task not found.',
      }).catch(() => null)
    }

    return
  }

  if (task.challenge_type === 'friend') {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text:
          user.language === 'ru'
            ? 'Friend challenge нужно менять в приложении.'
            : 'Friend challenge must be changed in the app.',
      }).catch(() => null)
    }

    return
  }

  const nextTime = buildExtendedTime(task.time, 15)

  if (!nextTime) {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text:
          user.language === 'ru'
            ? 'У задачи нет времени окончания.'
            : 'Task has no end time.',
      }).catch(() => null)
    }

    return
  }

  const { data: updatedTask, error: updateError } = await supabase
    .from('tasks')
    .update({
      time: nextTime,
      updated_at: new Date().toISOString(),
    })
    .eq('id', task.id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (updateError || !updatedTask) {
    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text:
          user.language === 'ru'
            ? 'Не получилось продлить задачу.'
            : 'Failed to extend task.',
      }).catch(() => null)
    }

    return
  }

  await rebuildTaskNotifications(updatedTask.id)

  if (chatId) {
    await sendTelegramMessage({
      chatId,
      text:
        user.language === 'ru'
          ? `⏱ Задача продлена: ${updatedTask.title}\nНовое время: ${updatedTask.time}`
          : `⏱ Task extended: ${updatedTask.title}\nNew time: ${updatedTask.time}`,
    }).catch(() => null)
  }

  console.log('TELEGRAM TASK EXTEND SUCCESS:', {
    taskId: updatedTask.id,
    time: updatedTask.time,
  })
}

async function handleFocusStartCallback({ callbackQuery, parsed, user }) {
  const callbackQueryId = callbackQuery.id

  const message = callbackQuery.message || {}
  const chatId = message.chat?.id
  const messageId = message.message_id

  const mode = parsed.mode === 'break' ? 'break' : 'work'
  const durationSeconds = Math.max(1, Number(parsed.durationSeconds || 0))

  if (!durationSeconds) {
    await safeAnswerCallbackQuery({
      callbackQueryId,
      text: 'Invalid timer duration.',
      showAlert: true,
    })

    return
  }

  const { error } = await supabase.from('focus_timer_commands').insert({
    user_id: user.id,
    mode,
    duration_seconds: durationSeconds,
    consumed: false,
    source: 'telegram',
  })

  if (error) {
    console.error('FOCUS_START_COMMAND_INSERT_ERROR:', error)

    await safeAnswerCallbackQuery({
      callbackQueryId,
      text:
        user.language === 'ru'
          ? 'Не получилось запустить таймер.'
          : 'Failed to start timer.',
      showAlert: true,
    })

    return
  }

  if (chatId && messageId) {
    const modeText = mode === 'work' ? 'work' : 'break'

    await editTelegramMessageText({
      chatId,
      messageId,
      text:
        user.language === 'ru'
          ? `▶️ ${modeText} time started in Fledix.`
          : `▶️ ${modeText} time started in Fledix.`,
      replyMarkup: {
        inline_keyboard: [],
      },
    }).catch((editError) => {
      console.error('FOCUS_START_MESSAGE_EDIT_ERROR:', editError.message)
    })
  }
}

async function handleCallbackQuery(callbackQuery) {
  console.log('TELEGRAM CALLBACK RECEIVED:', {
    id: callbackQuery.id,
    fromId: callbackQuery.from?.id,
    data: callbackQuery.data,
  })

  await safeAnswerCallbackQuery({
    callbackQueryId: callbackQuery.id,
    text: 'Processing...',
    showAlert: false,
  })

  const parsed = parseCallbackData(callbackQuery.data)

  console.log('TELEGRAM CALLBACK PARSED:', parsed)

  if (!parsed) {
    const chatId = callbackQuery.message?.chat?.id

    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text: 'Unknown action.',
      }).catch(() => null)
    }

    return
  }

  const telegramId = String(callbackQuery.from?.id || '')
  const user = await getUserByTelegramId(telegramId)

  if (!user) {
    const chatId = callbackQuery.message?.chat?.id

    if (chatId) {
      await sendTelegramMessage({
        chatId,
        text:
          'User not found. Open the app and enable Telegram notifications again.',
      }).catch(() => null)
    }

    return
  }

  const message = callbackQuery.message || {}
  const chatId = message.chat?.id
  const messageId = message.message_id

  if (!isActiveProUser(user)) {
    await editMessageAsProRequired({
      chatId,
      messageId,
      user,
    })

    return
  }

  if (parsed.type === 'task_done') {
    await handleTaskDoneCallback({
      callbackQuery,
      parsed,
      user,
    })

    return
  }

  if (parsed.type === 'task_extend') {
    await handleTaskExtendCallback({
      callbackQuery,
      parsed,
      user,
    })

    return
  }

  if (parsed.type === 'focus_start') {
    await handleFocusStartCallback({
      callbackQuery,
      parsed,
      user,
    })

    return
  }
}

router.post('/webhook', async (req, res) => {
  const update = req.body || {}

  console.log('TELEGRAM WEBHOOK UPDATE:', JSON.stringify(update))

  if (update.callback_query) {
    const callbackQuery = update.callback_query

    res.json({
      ok: true,
      handled: 'callback_query',
    })

    handleCallbackQuery(callbackQuery).catch((error) => {
      console.error('TELEGRAM CALLBACK HANDLE ERROR:', {
        message: error.message,
        stack: error.stack,
      })
    })

    return
  }

  try {
    const message = update.message || update.edited_message || null

    if (!message) {
      return res.json({
        ok: true,
        handled: 'empty',
      })
    }

    const chatId = message.chat?.id
    const text = message.text || ''
    const telegramId = message.from?.id || chatId

    console.log('TELEGRAM MESSAGE FOUND:', {
      chatId,
      telegramId,
      text,
    })

    if (!chatId) {
      return res.json({
        ok: true,
        handled: 'no_chat_id',
      })
    }

    if (text.startsWith('/start')) {
      await handleStartMessage({
        chatId,
        telegramId,
        text,
      })

      return res.json({
        ok: true,
        handled: 'start',
      })
    }

    return res.json({
      ok: true,
      handled: 'message',
    })
  } catch (error) {
    console.error('TELEGRAM WEBHOOK ERROR:', {
      message: error.message,
      stack: error.stack,
    })

    return res.json({
      ok: true,
      error: error.message,
    })
  }
})

module.exports = router