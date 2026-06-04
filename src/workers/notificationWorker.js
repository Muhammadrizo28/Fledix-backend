const os = require('os')
const { supabase } = require('../config/supabase')
const { sendTelegramMessage } = require('../services/telegram.service')

const WORKER_ID = `${os.hostname()}-${process.pid}`

const BATCH_SIZE = Number(process.env.NOTIFICATION_BATCH_SIZE || 50)
const MESSAGES_PER_SECOND = Number(process.env.TELEGRAM_MESSAGES_PER_SECOND || 25)
const SEND_DELAY_MS = Math.ceil(1000 / MESSAGES_PER_SECOND)

let isTickRunning = false
let intervalId = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRetryDate(error, attempts) {
  if (error.retryAfter) {
    return new Date(Date.now() + Number(error.retryAfter) * 1000).toISOString()
  }

  const delaySeconds = Math.min(60 * attempts, 600)

  return new Date(Date.now() + delaySeconds * 1000).toISOString()
}

async function markSent(notificationId) {
  await supabase
    .from('notifications')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', notificationId)
}

async function markFailedOrRetry(notification, error) {
  const attempts = Number(notification.attempts || 0) + 1

  const isPermanentTelegramError =
    error.status === 400 ||
    error.status === 403

  if (attempts >= 5 || isPermanentTelegramError) {
    await supabase
      .from('notifications')
      .update({
        status: 'failed',
        attempts,
        last_error: error.message || 'SEND_FAILED',
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', notification.id)

    return
  }

  await supabase
    .from('notifications')
    .update({
      status: 'pending',
      attempts,
      last_error: error.message || 'SEND_FAILED',
      next_retry_at: getRetryDate(error, attempts),
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', notification.id)
}

async function processNotification(notification) {
  try {
    await sendTelegramMessage({
      chatId: notification.telegram_id,
      text: notification.message,
    })

    await markSent(notification.id)
  } catch (error) {
    console.error('Telegram notification send error:', error.message)
    await markFailedOrRetry(notification, error)
  }
}

async function tick() {
  if (isTickRunning) return

  isTickRunning = true

  try {
    const { data, error } = await supabase.rpc('claim_due_notifications', {
      p_limit: BATCH_SIZE,
      p_worker_id: WORKER_ID,
    })

    if (error) {
      console.error('claim_due_notifications error:', error)
      return
    }

    const notifications = Array.isArray(data) ? data : []

    for (const notification of notifications) {
      await processNotification(notification)
      await sleep(SEND_DELAY_MS)
    }
  } catch (error) {
    console.error('Notification worker tick error:', error)
  } finally {
    isTickRunning = false
  }
}

function startNotificationWorker() {
  if (intervalId) return

  console.log(`Notification worker started: ${WORKER_ID}`)

  tick()

  intervalId = setInterval(() => {
    tick()
  }, 5000)
}

function stopNotificationWorker() {
  if (!intervalId) return

  clearInterval(intervalId)
  intervalId = null
}

module.exports = {
  startNotificationWorker,
  stopNotificationWorker,
}