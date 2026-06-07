const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

if (!TELEGRAM_BOT_TOKEN) {
  console.warn('TELEGRAM_BOT_TOKEN is missing')
}

const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`

async function telegramRequest(method, payload = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN_REQUIRED')
  }

  const response = await fetch(`${TELEGRAM_API_URL}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const data = await response.json().catch(() => null)

  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || `TELEGRAM_${method}_FAILED`)
    error.status = response.status
    error.retryAfter = data?.parameters?.retry_after || null
    error.telegramResponse = data
    throw error
  }

  return data.result
}

async function sendTelegramMessage({
  chatId,
  text,
  replyMarkup = null,
  parseMode = null,
  disableWebPagePreview = true,
}) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: disableWebPagePreview,
  }

  if (parseMode) {
    payload.parse_mode = parseMode
  }

  if (replyMarkup) {
    payload.reply_markup = replyMarkup
  }

  return telegramRequest('sendMessage', payload)
}

async function answerCallbackQuery({
  callbackQueryId,
  text = '',
  showAlert = false,
}) {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  })
}

async function editTelegramMessageReplyMarkup({
  chatId,
  messageId,
  replyMarkup = null,
}) {
  return telegramRequest('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  })
}

async function editTelegramMessageText({
  chatId,
  messageId,
  text,
  replyMarkup = null,
  parseMode = null,
  disableWebPagePreview = true,
}) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: disableWebPagePreview,
  }

  if (parseMode) {
    payload.parse_mode = parseMode
  }

  if (replyMarkup) {
    payload.reply_markup = replyMarkup
  }

  return telegramRequest('editMessageText', payload)
}

async function deleteTelegramMessage({ chatId, messageId }) {
  return telegramRequest('deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  })
}

module.exports = {
  sendTelegramMessage,
  answerCallbackQuery,
  editTelegramMessageReplyMarkup,
  editTelegramMessageText,
  deleteTelegramMessage,
}