const express = require('express')
const { z } = require('zod')

const { supabase } = require('../services/supabaseClient')
const { validateBody } = require('../middleware/validate')
const { authMiddleware } = require('../middleware/auth.middleware')

const {
  recordTaskCompletionEvent,
} = require('../services/challengeProgressService')

const {
  rebuildTaskNotifications,
  clearPendingTaskNotifications,
} = require('../services/notificationScheduler.service')

const router = express.Router()

const FREE_REGULAR_TASK_LIMIT = 4
const PRO_REGULAR_TASK_LIMIT = 10
const REGULAR_TASK_LIMIT_ERROR = 'REGULAR_TASK_LIMIT_REACHED'

function normalizeSubtasks(subtasks) {
  if (!Array.isArray(subtasks)) return []

  return subtasks.map((subtask, index) => {
    if (typeof subtask === 'string') {
      return {
        id: `subtask-${index}`,
        title: subtask,
        done: false,
        completed: false,
      }
    }

    const isDone = Boolean(subtask.done || subtask.completed)

    return {
      id: subtask.id || `subtask-${index}`,
      title: subtask.title || subtask.text || '',
      done: isDone,
      completed: isDone,
    }
  })
}

function getRegularTaskLimit(proSubscription) {
  return proSubscription ? PRO_REGULAR_TASK_LIMIT : FREE_REGULAR_TASK_LIMIT
}

async function getUserSubscription(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, pro_subscription')
    .eq('id', userId)
    .single()

  if (error || !data) {
    return {
      success: false,
      error: error?.message || 'USER_NOT_FOUND',
      proSubscription: false,
    }
  }

  return {
    success: true,
    proSubscription: Boolean(data.pro_subscription),
  }
}

function getTodayDateMs() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())

  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  const day = Number(parts.find((part) => part.type === 'day')?.value)

  return Date.UTC(year, month - 1, day)
}

function parseTaskDateMs(value) {
  if (!value || typeof value !== 'string') return null

  const dateValue = value.trim()

  if (!dateValue) return null

  // dd/mm/yyyy
  const ukMatch = dateValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)

  if (ukMatch) {
    const day = Number(ukMatch[1])
    const month = Number(ukMatch[2])
    const year = Number(ukMatch[3])

    return Date.UTC(year, month - 1, day)
  }

  // yyyy-mm-dd
  const isoMatch = dateValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)

  if (isoMatch) {
    const year = Number(isoMatch[1])
    const month = Number(isoMatch[2])
    const day = Number(isoMatch[3])

    return Date.UTC(year, month - 1, day)
  }

  const parsed = new Date(dateValue)

  if (Number.isNaN(parsed.getTime())) return null

  return Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate()
  )
}

function isCurrentOrFutureTask(task, todayMs) {
  const startDateMs = parseTaskDateMs(task.date)
  const endDateMs = parseTaskDateMs(task.end_date)

  // если есть end_date и он уже в прошлом — не считаем
  if (endDateMs !== null && endDateMs < todayMs) {
    return false
  }

  // если обычная задача без даты — считаем активной
  if (startDateMs === null) {
    return true
  }

  // считаем только сегодня и будущее
  return startDateMs >= todayMs
}

async function getRegularTaskCount(userId) {
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, date, end_date, challenge_type')
    .eq('user_id', userId)
    .is('challenge_type', null)

  if (error) {
    return {
      success: false,
      error: error.message,
      count: 0,
    }
  }

  const todayMs = getTodayDateMs()

  const activeRegularTasks = (tasks || []).filter((task) =>
    isCurrentOrFutureTask(task, todayMs)
  )

  return {
    success: true,
    count: activeRegularTasks.length,
  }
}

function sendRegularTaskLimitError(res, payload = {}) {
  return res.status(409).json({
    success: false,
    error: REGULAR_TASK_LIMIT_ERROR,
    key: REGULAR_TASK_LIMIT_ERROR,
    code: REGULAR_TASK_LIMIT_ERROR,
    message: 'Regular task limit reached.',
    ...payload,
  })
}

const createTaskSchema = z.object({
  title: z.string().min(1).max(150),
  description: z.string().max(1000).optional().default(''),
  tag: z.string().max(100).optional().default(''),
  date: z.string().max(20).optional().default(''),
  time: z.string().max(30).optional().default(''),

  repeat: z.array(z.any()).optional().default([]),

  subtaskArr: z.array(z.any()).optional().default([]),
  subtask_arr: z.array(z.any()).optional(),

  done: z.array(z.any()).optional().default([]),

  frozen: z.boolean().optional().default(false),
  completed: z.boolean().optional().default(false),
})

const updateTaskSchema = z.object({
  title: z.string().min(1).max(150).optional(),
  description: z.string().max(1000).optional(),
  tag: z.string().max(100).optional(),
  date: z.string().max(20).optional(),
  time: z.string().max(30).optional(),

  repeat: z.array(z.any()).optional(),

  subtaskArr: z.array(z.any()).optional(),
  subtask_arr: z.array(z.any()).optional(),

  frozen: z.boolean().optional(),
  completed: z.boolean().optional(),

  start_date: z.string().optional(),
  end_date: z.string().optional(),
})

router.get('/', authMiddleware, async (req, res) => {
  const userId = req.user.id

  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  return res.json({
    success: true,
    tasks: data,
  })
})

router.post(
  '/',
  authMiddleware,
  validateBody(createTaskSchema),
  async (req, res) => {
    const userId = req.user.id

    const {
      title,
      description,
      tag,
      date,
      time,
      repeat,
      subtaskArr,
      subtask_arr,
      done,
      frozen,
      completed,
    } = req.body

    const subscriptionResult = await getUserSubscription(userId)

    if (!subscriptionResult.success) {
      return res.status(500).json({
        success: false,
        error: subscriptionResult.error,
      })
    }

    const proSubscription = subscriptionResult.proSubscription
    const taskLimit = getRegularTaskLimit(proSubscription)

    const taskCountResult = await getRegularTaskCount(userId)

    if (!taskCountResult.success) {
      return res.status(500).json({
        success: false,
        error: taskCountResult.error,
      })
    }

    if (taskCountResult.count >= taskLimit) {
      return sendRegularTaskLimitError(res, {
        limit: taskLimit,
        currentCount: taskCountResult.count,
        proSubscription,
        freeLimit: FREE_REGULAR_TASK_LIMIT,
        proLimit: PRO_REGULAR_TASK_LIMIT,
      })
    }

    const normalizedSubtasks = normalizeSubtasks(subtaskArr || subtask_arr)

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        user_id: userId,
        title,
        description,
        tag,
        date,
        time,
        repeat,
        subtask_arr: normalizedSubtasks,
        done,
        frozen,
        completed,
        challenge_type: null,
        challenge_status: null,
      })
      .select()
      .single()

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      })
    }

    let notificationResult = null

    try {
      notificationResult = await rebuildTaskNotifications(data.id)
      console.log('CREATE TASK NOTIFICATION RESULT:', notificationResult)
    } catch (notificationError) {
      console.error('Create task notification rebuild error:', notificationError)

      notificationResult = {
        success: false,
        reason: 'REBUILD_THROW_ERROR',
        error: notificationError.message,
      }
    }

    return res.json({
      success: true,
      task: data,
      notificationResult,
      taskLimit: {
        limit: taskLimit,
        currentCount: taskCountResult.count + 1,
        proSubscription,
        freeLimit: FREE_REGULAR_TASK_LIMIT,
        proLimit: PRO_REGULAR_TASK_LIMIT,
      },
    })
  }
)

router.patch(
  '/:taskId',
  authMiddleware,
  validateBody(updateTaskSchema),
  async (req, res) => {
    const userId = req.user.id
    const { taskId } = req.params

    const updateData = {
      updated_at: new Date().toISOString(),
    }

    const allowedFields = [
      'title',
      'description',
      'tag',
      'date',
      'time',
      'repeat',
      'frozen',
      'completed',
      'start_date',
      'end_date',
    ]

    allowedFields.forEach((field) => {
      if (field in req.body) {
        updateData[field] = req.body[field]
      }
    })

    if ('subtaskArr' in req.body || 'subtask_arr' in req.body) {
      updateData.subtask_arr = normalizeSubtasks(
        req.body.subtaskArr || req.body.subtask_arr
      )
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updateData)
      .eq('id', taskId)
      .eq('user_id', userId)
      .select()
      .single()

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      })
    }

    let notificationResult = null

    try {
      notificationResult = await rebuildTaskNotifications(data.id)
      console.log('UPDATE TASK NOTIFICATION RESULT:', notificationResult)
    } catch (notificationError) {
      console.error('Update task notification rebuild error:', notificationError)

      notificationResult = {
        success: false,
        reason: 'REBUILD_THROW_ERROR',
        error: notificationError.message,
      }
    }

    return res.json({
      success: true,
      task: data,
      notificationResult,
    })
  }
)

router.delete('/:taskId', authMiddleware, async (req, res) => {
  const userId = req.user.id
  const { taskId } = req.params

  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .eq('user_id', userId)

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  try {
    await clearPendingTaskNotifications(taskId)
  } catch (notificationError) {
    console.error('Delete task notification clear error:', notificationError)
  }

  return res.json({
    success: true,
  })
})

router.patch('/:taskId/done', authMiddleware, async (req, res) => {
  const userId = req.user.id
  const { taskId } = req.params
  const date = String(req.body?.date || '').trim()

  if (!date) {
    return res.status(400).json({
      success: false,
      error: 'DATE_IS_REQUIRED',
    })
  }

  const { data: task, error: findError } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .eq('user_id', userId)
    .single()

  if (findError || !task) {
    return res.status(404).json({
      success: false,
      error: 'TASK_NOT_FOUND',
    })
  }

  if (task.challenge_type === 'friend') {
    return res.status(400).json({
      success: false,
      error: 'USE_FRIEND_CHALLENGE_DONE_ENDPOINT',
    })
  }

  const currentDone = Array.isArray(task.done) ? task.done : []
  const alreadyDone = currentDone.includes(date)

  const nextDone = alreadyDone
    ? currentDone.filter((item) => item !== date)
    : [...currentDone, date]

  const { data: updatedTask, error: updateError } = await supabase
    .from('tasks')
    .update({
      done: nextDone,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .eq('user_id', userId)
    .select()
    .single()

  if (updateError) {
    return res.status(500).json({
      success: false,
      error: updateError.message,
    })
  }

  if (!alreadyDone) {
    const eventResult = await recordTaskCompletionEvent({
      userId,
      taskId: updatedTask.id,
      completionDate: date,
      taskType: 'regular',
      source: 'regular_task_checkbox',
    })

    if (!eventResult?.success) {
      console.error('Task completion event error:', eventResult?.error)
    }
  }

  return res.json({
    success: true,
    task: updatedTask,
    checked: !alreadyDone,
    date,
  })
})

module.exports = router