require('dotenv').config()

async function setTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const backendUrl = process.env.PUBLIC_BACKEND_URL
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required')
  }

  if (!backendUrl) {
    throw new Error('PUBLIC_BACKEND_URL is required')
  }

  const webhookUrl = `${backendUrl}/api/telegram/webhook`

  const response = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ['message'],
      }),
    }
  )

  const data = await response.json()

  console.log(data)

  if (!data.ok) {
    throw new Error(data.description || 'SET_WEBHOOK_FAILED')
  }

  console.log(`Webhook set: ${webhookUrl}`)
}

setTelegramWebhook().catch((error) => {
  console.error(error)
  process.exit(1)
})