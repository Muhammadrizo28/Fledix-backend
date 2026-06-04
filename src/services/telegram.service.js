async function sendTelegramMessage({ chatId, text }) {
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
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    }
  )

  const data = await response.json().catch(() => null)

  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || 'TELEGRAM_SEND_FAILED')
    error.status = response.status
    error.retryAfter = data?.parameters?.retry_after || null
    throw error
  }

  return data
}

module.exports = {
  sendTelegramMessage,
}