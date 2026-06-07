const express = require('express')

const { supabase } = require('../services/supabaseClient')

const router = express.Router()

const { supabase } = require('../services/supabaseClient')

const {
  answerCallbackQuery,
  editTelegramMessageReplyMarkup,
  sendTelegramMessage,
} = require('../services/telegram.service')

const {
  recordTaskCompletionEvent,
} = require('../services/challengeProgressService')

const {
  rebuildTaskNotifications,
} = require('../services/notificationScheduler.service')

function checkTelegramSecret(req, res, next) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  const receivedSecret = req.headers['x-telegram-bot-api-secret-token']

  if (expectedSecret && receivedSecret !== expectedSecret) {
    return res.status(403).json({
      success: false,
      error: 'INVALID_TELEGRAM_SECRET',
    })
  }

  next()
}

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

async function sendTelegramMessage(chatId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN_REQUIRED')
  }

  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    }
  )

  const data = await response.json().catch(() => null)

  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || 'TELEGRAM_SEND_FAILED')
  }

  return data
}

router.post('/webhook', checkTelegramSecret, async (req, res) => {
  try {
    const update = req.body || {}

    const message =
      update.message ||
      update.edited_message ||
      update.callback_query?.message ||
      null

    const chatId = message?.chat?.id
    const text = message?.text || ''
    const telegramId = message?.from?.id || chatId

    if (!chatId) {
      return res.json({ ok: true })
    }

    if (text.startsWith('/start')) {
      const startPayload = getStartPayload(text)

      if (startPayload.startsWith('ref_')) {
        await savePendingReferral({
          telegramId,
          referralCode: startPayload,
        })

        await sendTelegramMessage(
          chatId,
          'Welcome to Fledix ✅\n\nReferral saved. Now open the app to continue.'
        )

        return res.json({ ok: true })
      }

      await sendTelegramMessage(
        chatId,
        'Welcome to Fledix ✅\n\nOpen the app and enable notifications to receive task reminders here.'
      )
    }

    return res.json({ ok: true })
  } catch (error) {
    console.error('Telegram webhook error:', error)

    return res.json({ ok: true })
  }
})

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

  if (parts[0] === 'task_done') {
    return {
      type: 'task_done',
      taskId: parts[1],
      doneDate: parts[2],
    }
  }

  if (parts[0] === 'task_extend') {
    return {
      type: 'task_extend',
      taskId: parts[1],
    }
  }

  return null
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
    .eq('telegram_id', telegramId)
    .single()

  if (error || !user) {
    return null
  }

  return user
}

async function sendProRequiredMessage({ user, chatId, callbackQueryId }) {
  const text =
    user?.language === 'ru'
      ? '🔒 Для этого действия нужна Pro подписка.'
      : '🔒 Pro subscription is required for this action.'

  await answerCallbackQuery({
    callbackQueryId,
    text,
    showAlert: true,
  })

  if (chatId) {
    await sendTelegramMessage({
      chatId,
      text,
    }).catch(() => null)
  }
}

async function handleTaskDoneCallback({ callbackQuery, parsed }) {
  const callbackQueryId = callbackQuery.id
  const telegramId = String(callbackQuery.from?.id || '')

  const message = callbackQuery.message || {}
  const chatId = message.chat?.id
  const messageId = message.message_id

  const user = await getUserByTelegramId(telegramId)

  if (!user) {
    await answerCallbackQuery({
      callbackQueryId,
      text: 'User not found.',
      showAlert: true,
    })

    return
  }

  if (!isActiveProUser(user)) {
    await sendProRequiredMessage({
      user,
      chatId,
      callbackQueryId,
    })

    return
  }

  const { taskId, doneDate } = parsed

  if (!taskId || !doneDate) {
    await answerCallbackQuery({
      callbackQueryId,
      text: 'Invalid task action.',
      showAlert: true,
    })

    return
  }

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('id, user_id, title, done, challenge_type')
    .eq('id', taskId)
    .eq('user_id', user.id)
    .single()

  if (taskError || !task) {
    await answerCallbackQuery({
      callbackQueryId,
      text: user.language === 'ru' ? 'Задача не найдена.' : 'Task not found.',
      showAlert: true,
    })

    return
  }

  if (task.challenge_type === 'friend') {
    await answerCallbackQuery({
      callbackQueryId,
      text:
        user.language === 'ru'
          ? 'Friend challenge нужно закрывать в приложении.'
          : 'Friend challenge must be completed in the app.',
      showAlert: true,
    })

    return
  }

  const currentDone = Array.isArray(task.done) ? task.done : []

  if (currentDone.includes(doneDate)) {
    await answerCallbackQuery({
      callbackQueryId,
      text:
        user.language === 'ru'
          ? 'Уже отмечено как выполнено.'
          : 'Already marked as done.',
      showAlert: false,
    })

    if (chatId && messageId) {
      await editTelegramMessageReplyMarkup({
        chatId,
        messageId,
        replyMarkup: null,
      }).catch(() => null)
    }

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
    await answerCallbackQuery({
      callbackQueryId,
      text:
        user.language === 'ru'
          ? 'Не получилось обновить задачу.'
          : 'Failed to update task.',
      showAlert: true,
    })

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

  await answerCallbackQuery({
    callbackQueryId,
    text: user.language === 'ru' ? 'Готово ✅' : 'Done ✅',
    showAlert: false,
  })

  if (chatId && messageId) {
    await editTelegramMessageReplyMarkup({
      chatId,
      messageId,
      replyMarkup: null,
    }).catch(() => null)
  }
}

async function handleTaskExtendCallback({ callbackQuery, parsed }) {
  const callbackQueryId = callbackQuery.id
  const telegramId = String(callbackQuery.from?.id || '')

  const message = callbackQuery.message || {}
  const chatId = message.chat?.id

  const user = await getUserByTelegramId(telegramId)

  if (!user) {
    await answerCallbackQuery({
      callbackQueryId,
      text: 'User not found.',
      showAlert: true,
    })

    return
  }

  if (!isActiveProUser(user)) {
    await sendProRequiredMessage({
      user,
      chatId,
      callbackQueryId,
    })

    return
  }

  const { taskId } = parsed

  if (!taskId) {
    await answerCallbackQuery({
      callbackQueryId,
      text: 'Invalid task action.',
      showAlert: true,
    })

    return
  }

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('id, user_id, title, time, challenge_type')
    .eq('id', taskId)
    .eq('user_id', user.id)
    .single()

  if (taskError || !task) {
    await answerCallbackQuery({
      callbackQueryId,
      text: user.language === 'ru' ? 'Задача не найдена.' : 'Task not found.',
      showAlert: true,
    })

    return
  }

  if (task.challenge_type === 'friend') {
    await answerCallbackQuery({
      callbackQueryId,
      text:
        user.language === 'ru'
          ? 'Friend challenge нужно менять в приложении.'
          : 'Friend challenge must be changed in the app.',
      showAlert: true,
    })

    return
  }

  const nextTime = buildExtendedTime(task.time, 15)

  if (!nextTime) {
    await answerCallbackQuery({
      callbackQueryId,
      text:
        user.language === 'ru'
          ? 'У задачи нет времени окончания.'
          : 'Task has no end time.',
      showAlert: true,
    })

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
    await answerCallbackQuery({
      callbackQueryId,
      text:
        user.language === 'ru'
          ? 'Не получилось продлить задачу.'
          : 'Failed to extend task.',
      showAlert: true,
    })

    return
  }

  await rebuildTaskNotifications(updatedTask.id)

  await answerCallbackQuery({
    callbackQueryId,
    text:
      user.language === 'ru'
        ? 'Продлено на 15 минут ✅'
        : 'Extended by 15 minutes ✅',
    showAlert: false,
  })

  if (chatId) {
    await sendTelegramMessage({
      chatId,
      text:
        user.language === 'ru'
          ? `⏱ Задача продлена: ${updatedTask.title}\nНовое время: ${updatedTask.time}`
          : `⏱ Task extended: ${updatedTask.title}\nNew time: ${updatedTask.time}`,
    }).catch(() => null)
  }
}

router.post('/webhook', async (req, res) => {
  try {
    const update = req.body || {}

    if (update.callback_query) {
      const parsed = parseCallbackData(update.callback_query.data)

      if (parsed?.type === 'task_done') {
        await handleTaskDoneCallback({
          callbackQuery: update.callback_query,
          parsed,
        })
      }

      if (parsed?.type === 'task_extend') {
        await handleTaskExtendCallback({
          callbackQuery: update.callback_query,
          parsed,
        })
      }
    }

    return res.json({
      success: true,
    })
  } catch (error) {
    console.error('Telegram webhook error:', error)

    return res.json({
      success: true,
    })
  }
})

module.exports = router