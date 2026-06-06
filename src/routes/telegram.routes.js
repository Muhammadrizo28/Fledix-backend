const express = require('express')

const { supabase } = require('../services/supabaseClient')

const router = express.Router()

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

module.exports = router