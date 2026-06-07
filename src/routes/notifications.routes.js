const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')
const { sendTelegramMessage } = require('../services/telegram.service')

const router = express.Router()

router.get('/settings', authMiddleware, async (req, res) => {
  const { data: user, error } = await supabase
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
      notify_subscription_end,
      subscription_end_at
      `
    )
    .eq('id', req.user.id)
    .single()

  if (error || !user) {
    return res.status(404).json({
      success: false,
      error: 'USER_NOT_FOUND',
    })
  }

  return res.json({
    success: true,
    settings: {
      telegramId: user.telegram_id || '',
      timezone: user.timezone || 'Europe/London',
      language: user.language || 'en',
      notificationsEnabled: user.notifications_enabled !== false,
      notifyTaskStart: user.notify_task_start !== false,
      notifyTaskEnd: user.notify_task_end !== false,
      notifySubscriptionEnd: user.notify_subscription_end !== false,
      subscriptionEndAt: user.subscription_end_at || null,
    },
  })
})

router.patch('/settings', authMiddleware, async (req, res) => {
  const allowedTimezones = [
    'Europe/London',
    'Europe/Berlin',
    'Asia/Tashkent',
    'UTC',
  ]

  const body = req.body || {}
  const patch = {}

  if (typeof body.telegramId === 'string') {
    patch.telegram_id = body.telegramId.trim() || null
  }

  if (typeof body.timezone === 'string') {
    patch.timezone = allowedTimezones.includes(body.timezone)
      ? body.timezone
      : 'Europe/London'
  }

  if (body.language === 'en' || body.language === 'ru') {
    patch.language = body.language
  }

  if (typeof body.notificationsEnabled === 'boolean') {
    patch.notifications_enabled = body.notificationsEnabled
  }

  if (typeof body.notifyTaskStart === 'boolean') {
    patch.notify_task_start = body.notifyTaskStart
  }

  if (typeof body.notifyTaskEnd === 'boolean') {
    patch.notify_task_end = body.notifyTaskEnd
  }

  if (typeof body.notifySubscriptionEnd === 'boolean') {
    patch.notify_subscription_end = body.notifySubscriptionEnd
  }

  const { data, error } = await supabase
    .from('users')
    .update(patch)
    .eq('id', req.user.id)
    .select(
      `
      id,
      telegram_id,
      timezone,
      language,
      notifications_enabled,
      notify_task_start,
      notify_task_end,
      notify_subscription_end,
      subscription_end_at
      `
    )
    .single()

  if (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'SETTINGS_UPDATE_FAILED',
    })
  }

  return res.json({
    success: true,
    settings: {
      telegramId: data.telegram_id || '',
      timezone: data.timezone || 'Europe/London',
      language: data.language || 'en',
      notificationsEnabled: data.notifications_enabled !== false,
      notifyTaskStart: data.notify_task_start !== false,
      notifyTaskEnd: data.notify_task_end !== false,
      notifySubscriptionEnd: data.notify_subscription_end !== false,
      subscriptionEndAt: data.subscription_end_at || null,
    },
  })
})

router.post('/test', authMiddleware, async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('telegram_id, language')
    .eq('id', req.user.id)
    .single()

  if (error || !user) {
    return res.status(404).json({
      success: false,
      error: 'USER_NOT_FOUND',
    })
  }

  if (!user.telegram_id) {
    return res.status(400).json({
      success: false,
      error: 'TELEGRAM_ID_REQUIRED',
    })
  }

  const text =
    user.language === 'ru'
      ? '✅ Тестовое уведомление от Fledix.'
      : '✅ Test notification from Fledix.'

  try {
    await sendTelegramMessage({
      chatId: user.telegram_id,
      text,
    })

    return res.json({
      success: true,
    })
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'TEST_NOTIFICATION_FAILED',
    })
  }
})

module.exports = router