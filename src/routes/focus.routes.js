const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')
const { sendTelegramMessage } = require('../services/telegram.service')

const router = express.Router()

const MODE_WORK = 'work'
const MODE_BREAK = 'break'

function normalizeMode(value) {
  return value === MODE_BREAK ? MODE_BREAK : MODE_WORK
}

function getNextMode(mode) {
  return mode === MODE_WORK ? MODE_BREAK : MODE_WORK
}

function getDurationForMode({ mode, workSeconds, breakSeconds }) {
  const safeWorkSeconds = Math.max(1, Number(workSeconds || 25 * 60))
  const safeBreakSeconds = Math.max(1, Number(breakSeconds || 5 * 60))

  return mode === MODE_WORK ? safeWorkSeconds : safeBreakSeconds
}

function buildTimerEndedText({ user, endedMode }) {
  if (user.language === 'ru') {
    return endedMode === MODE_WORK
      ? '⏰ Рабочий таймер закончился.'
      : '☕ Перерыв закончился.'
  }

  return endedMode === MODE_WORK
    ? '⏰ Work timer finished.'
    : '☕ Break timer finished.'
}

function buildStartButtonText({ user, nextMode }) {
  if (user.language === 'ru') {
    return nextMode === MODE_WORK
      ? '▶️ Start work time'
      : '▶️ Start break time'
  }

  return nextMode === MODE_WORK
    ? '▶️ Start work time'
    : '▶️ Start break time'
}

router.post('/timer-ended', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const endedMode = normalizeMode(req.body?.endedMode)
    const nextMode = normalizeMode(req.body?.nextMode || getNextMode(endedMode))

    const workSeconds = Number(req.body?.workSeconds || 25 * 60)
    const breakSeconds = Number(req.body?.breakSeconds || 5 * 60)

    const nextDurationSeconds = getDurationForMode({
      mode: nextMode,
      workSeconds,
      breakSeconds,
    })

    const { data: user, error: userError } = await supabase
      .from('users')
      .select(
        `
        id,
        telegram_id,
        language,
        notifications_enabled
        `
      )
      .eq('id', userId)
      .single()

    if (userError || !user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
      })
    }

    if (!user.telegram_id) {
      return res.json({
        success: true,
        notificationSent: false,
        reason: 'TELEGRAM_ID_NOT_FOUND',
      })
    }

    if (user.notifications_enabled === false) {
      return res.json({
        success: true,
        notificationSent: false,
        reason: 'NOTIFICATIONS_DISABLED',
      })
    }

    await sendTelegramMessage({
      chatId: user.telegram_id,
      text: buildTimerEndedText({
        user,
        endedMode,
      }),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: buildStartButtonText({
                user,
                nextMode,
              }),
              callback_data: `focus_start:${nextMode}:${nextDurationSeconds}`,
            },
          ],
        ],
      },
    })

    return res.json({
      success: true,
      notificationSent: true,
      endedMode,
      nextMode,
      nextDurationSeconds,
    })
  } catch (error) {
    console.error('FOCUS_TIMER_ENDED_ERROR:', error)

    return res.status(500).json({
      success: false,
      error: error.message || 'FOCUS_TIMER_ENDED_FAILED',
    })
  }
})

router.get('/command', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const { data: command, error } = await supabase
      .from('focus_timer_commands')
      .select('id, mode, duration_seconds, created_at')
      .eq('user_id', userId)
      .eq('consumed', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message || 'FOCUS_COMMAND_LOAD_FAILED',
      })
    }

    if (!command) {
      return res.json({
        success: true,
        command: null,
      })
    }

    return res.json({
      success: true,
      command: {
        id: command.id,
        mode: command.mode,
        durationSeconds: Number(command.duration_seconds || 0),
        createdAt: command.created_at,
      },
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'FOCUS_COMMAND_LOAD_FAILED',
    })
  }
})

router.post('/command/:commandId/consume', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { commandId } = req.params

    const { error } = await supabase
      .from('focus_timer_commands')
      .update({
        consumed: true,
        consumed_at: new Date().toISOString(),
      })
      .eq('id', commandId)
      .eq('user_id', userId)

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message || 'FOCUS_COMMAND_CONSUME_FAILED',
      })
    }

    return res.json({
      success: true,
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'FOCUS_COMMAND_CONSUME_FAILED',
    })
  }
})

module.exports = router