const crypto = require('crypto')

function parseInitData(initData) {
  const params = new URLSearchParams(initData)
  const data = {}

  for (const [key, value] of params.entries()) {
    data[key] = value
  }

  return data
}

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) {
    return {
      valid: false,
      error: 'MISSING_INIT_DATA_OR_BOT_TOKEN',
    }
  }

  const data = parseInitData(initData)
  const receivedHash = data.hash

  if (!receivedHash) {
    return {
      valid: false,
      error: 'HASH_NOT_FOUND',
    }
  }

  delete data.hash

  const dataCheckString = Object.keys(data)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('\n')

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest()

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex')

  const receivedBuffer = Buffer.from(receivedHash, 'hex')
  const calculatedBuffer = Buffer.from(calculatedHash, 'hex')

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, calculatedBuffer)
  ) {
    return {
      valid: false,
      error: 'INVALID_TELEGRAM_HASH',
    }
  }

  const authDate = Number(data.auth_date)
  const now = Math.floor(Date.now() / 1000)
  const maxAge = 60 * 60 * 24

  if (!authDate || now - authDate > maxAge) {
    return {
      valid: false,
      error: 'TELEGRAM_AUTH_EXPIRED',
    }
  }

  let telegramUser = null

  try {
    telegramUser = JSON.parse(data.user)
  } catch (error) {
    return {
      valid: false,
      error: 'INVALID_TELEGRAM_USER',
    }
  }

  if (!telegramUser?.id) {
    return {
      valid: false,
      error: 'TELEGRAM_USER_ID_NOT_FOUND',
    }
  }

  return {
    valid: true,
    user: telegramUser,
  }
}

module.exports = { verifyTelegramInitData }