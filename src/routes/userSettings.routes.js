const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')

const router = express.Router()

const LANGUAGE_CHANGE_COOLDOWN_MS = 2000
const cooldowns = new Map()

function getCooldownKey(userId) {
  return `language:${userId}`
}

function getRemainingCooldownMs(userId) {
  const key = getCooldownKey(userId)
  const lastTime = cooldowns.get(key)

  if (!lastTime) return 0

  const passedMs = Date.now() - lastTime
  const remainingMs = LANGUAGE_CHANGE_COOLDOWN_MS - passedMs

  return remainingMs > 0 ? remainingMs : 0
}

function setCooldown(userId) {
  const key = getCooldownKey(userId)

  cooldowns.set(key, Date.now())

  setTimeout(() => {
    cooldowns.delete(key)
  }, LANGUAGE_CHANGE_COOLDOWN_MS + 1000)
}

router.patch('/language', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { language } = req.body || {}

    const remainingMs = getRemainingCooldownMs(userId)

    if (remainingMs > 0) {
      return res.status(429).json({
        success: false,
        error: 'LANGUAGE_CHANGE_RATE_LIMITED',
        retryAfterSeconds: Math.ceil(remainingMs / 1000),
      })
    }

    if (language !== 'en' && language !== 'ru') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_LANGUAGE',
      })
    }

    setCooldown(userId)

    const { data: user, error } = await supabase
      .from('users')
      .update({ language })
      .eq('id', userId)
      .select('id, language')
      .single()

    if (error || !user) {
      return res.status(400).json({
        success: false,
        error: error?.message || 'LANGUAGE_UPDATE_FAILED',
      })
    }

    return res.json({
      success: true,
      language: user.language,
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'LANGUAGE_UPDATE_FAILED',
    })
  }
})

module.exports = router