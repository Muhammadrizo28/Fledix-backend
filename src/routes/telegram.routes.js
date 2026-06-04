const express = require('express')

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

    if (!chatId) {
      return res.json({ ok: true })
    }

    if (text.startsWith('/start')) {
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