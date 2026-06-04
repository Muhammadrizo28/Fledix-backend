const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')

const {
  rebuildSubscriptionNotifications,
} = require('../services/notificationScheduler.service')

const router = express.Router()

function serializeSubscription(user) {
  const proExpiresAt = user.pro_expires_at || null

  const isExpired =
    proExpiresAt && new Date(proExpiresAt).getTime() <= Date.now()

  const proSubscription = Boolean(user.pro_subscription) && !isExpired

  return {
    proSubscription,
    proExpiresAt,
    proPlan: proSubscription ? user.pro_plan || null : null,
    isExpired: Boolean(isExpired),
  }
}

router.get('/check', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const { data: user, error } = await supabase
      .from('users')
      .select('id, pro_subscription, pro_expires_at, pro_plan')
      .eq('id', userId)
      .single()

    if (error || !user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
      })
    }

    const subscription = serializeSubscription(user)

    if (subscription.isExpired && user.pro_subscription) {
      await supabase
        .from('users')
        .update({
          pro_subscription: false,
          pro_plan: null,
        })
        .eq('id', userId)
    }

    res.json({
      success: true,
      subscription,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'SUBSCRIPTION_CHECK_FAILED',
    })
  }
})

router.post('/sync-notifications', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const { data: user, error } = await supabase
      .from('users')
      .select('id, pro_subscription, pro_expires_at, pro_plan')
      .eq('id', userId)
      .single()

    if (error || !user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
      })
    }

    const subscription = serializeSubscription(user)

    if (!subscription.proSubscription) {
      return res.status(400).json({
        success: false,
        error: 'NO_ACTIVE_SUBSCRIPTION',
      })
    }

    await rebuildSubscriptionNotifications(userId)

    res.json({
      success: true,
      subscription,
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'SUBSCRIPTION_NOTIFICATION_SYNC_FAILED',
    })
  }
})

module.exports = router