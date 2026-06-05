const express = require('express')
const crypto = require('crypto')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')

const router = express.Router()

function verifyTelegramInitData(initData) {
  if (!initData || !process.env.TELEGRAM_BOT_TOKEN) {
    return {
      ok: false,
      error: 'TELEGRAM_INIT_DATA_REQUIRED',
    }
  }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')

  if (!hash) {
    return {
      ok: false,
      error: 'TELEGRAM_HASH_REQUIRED',
    }
  }

  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN)
    .digest()

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex')

  if (calculatedHash !== hash) {
    return {
      ok: false,
      error: 'INVALID_TELEGRAM_INIT_DATA',
    }
  }

  const userRaw = params.get('user')

  if (!userRaw) {
    return {
      ok: false,
      error: 'TELEGRAM_USER_REQUIRED',
    }
  }

  const telegramUser = JSON.parse(userRaw)

  return {
    ok: true,
    user: telegramUser,
  }
}

function normalizeTelegramUsername(username, telegramId) {
  const cleanUsername = String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, 40)

  return cleanUsername || `tg_${telegramId}`
}

router.post('/link', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const initData = req.body?.initData || ''

    const verified = verifyTelegramInitData(initData)

    if (!verified.ok) {
      return res.status(400).json({
        success: false,
        error: verified.error,
      })
    }

    const telegramUser = verified.user
    const telegramId = String(telegramUser.id)

    const telegramNickname = normalizeTelegramUsername(
      telegramUser.username,
      telegramId
    )

    const { data, error } = await supabase
      .from('users')
      .update({
        telegram_id: telegramId,

        username: telegramNickname,
        app_nickname: telegramNickname,
        telegram_username: telegramNickname,

        first_name: telegramUser.first_name || '',
        last_name: telegramUser.last_name || '',

        telegram_first_name: telegramUser.first_name || null,
        telegram_last_name: telegramUser.last_name || null,

        telegram_avatar_url: telegramUser.photo_url || '',
        telegram_photo_url: telegramUser.photo_url || null,

        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select(
        'id, username, app_nickname, telegram_id, telegram_username, first_name, last_name, telegram_first_name, telegram_last_name, telegram_avatar_url, telegram_photo_url'
      )
      .single()

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      })
    }

    return res.json({
      success: true,
      telegram: data,
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'TELEGRAM_LINK_FAILED',
    })
  }
})

module.exports = router