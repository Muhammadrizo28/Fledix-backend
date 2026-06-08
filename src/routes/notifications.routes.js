const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')
const { sendTelegramMessage } = require('../services/telegram.service')

const router = express.Router()

function serializeSettings(user) {
  return {
    telegramId: user.telegram_id || '',
    timezone: user.timezone || 'Europe/London',
    language: user.language || 'en',

    notificationsEnabled: user.notifications_enabled !== false,

    notifyTaskStart: user.notify_task_start !== false,
    notifyTaskEnd: user.notify_task_end !== false,
    notifyFocusTimer: user.notify_focus_timer !== false,
    notifySubscriptionEnd: user.notify_subscription_end !== false,

    subscriptionEndAt: user.subscription_end_at || null,
  }
}

router.get('/settings', authMiddleware, async (req, res) => {
  try {
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
        notify_focus_timer,
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
      settings: serializeSettings(user),
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'NOTIFICATION_SETTINGS_LOAD_FAILED',
    })
  }
})

router.patch('/settings', authMiddleware, async (req, res) => {
  try {
    const body = req.body || {}
    const patch = {}

    if (typeof body.notificationsEnabled === 'boolean') {
      patch.notifications_enabled = body.notificationsEnabled
    }

    if (typeof body.notifyTaskStart === 'boolean') {
      patch.notify_task_start = body.notifyTaskStart
    }

    if (typeof body.notifyTaskEnd === 'boolean') {
      patch.notify_task_end = body.notifyTaskEnd
    }

    if (typeof body.notifyFocusTimer === 'boolean') {
      patch.notify_focus_timer = body.notifyFocusTimer
    }

    if (typeof body.notifySubscriptionEnd === 'boolean') {
      patch.notify_subscription_end = body.notifySubscriptionEnd
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'NO_VALID_SETTINGS_TO_UPDATE',
      })
    }

    const { data: user, error } = await supabase
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
        notify_focus_timer,
        notify_subscription_end,
        subscription_end_at
        `
      )
      .single()

    if (error || !user) {
      return res.status(400).json({
        success: false,
        error: error?.message || 'NOTIFICATION_SETTINGS_UPDATE_FAILED',
      })
    }

    return res.json({
      success: true,
      settings: serializeSettings(user),
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'NOTIFICATION_SETTINGS_UPDATE_FAILED',
    })
  }
})

router.post('/test', authMiddleware, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('telegram_id, language, notifications_enabled')
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

    if (user.notifications_enabled === false) {
      return res.status(400).json({
        success: false,
        error: 'NOTIFICATIONS_DISABLED',
      })
    }

    const text =
      user.language === 'ru'
        ? '✅ Тестовое уведомление от Fledix.'
        : '✅ Test notification from Fledix.'

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