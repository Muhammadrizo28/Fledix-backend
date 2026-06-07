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

async function getRegularTaskCount(userId) {
  const { count, error } = await supabase
    .from('tasks')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('user_id', userId)
    .or('challenge_type.is.null,challenge_type.neq.friend')

  if (error) {
    return {
      success: false,
      error: error.message,
      count: 0,
    }
  }

  return {
    success: true,
    count: Number(count || 0),
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
  time: z.string().max(20).optional().default(''),

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
  time: z.string().max(20).optional(),

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

  res.json({
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

    rebuildTaskNotifications(data.id).catch((notificationError) => {
      console.error('Create task notification rebuild error:', notificationError)
    })

    res.json({
      success: true,
      task: data,
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

    rebuildTaskNotifications(data.id).catch((notificationError) => {
      console.error('Update task notification rebuild error:', notificationError)
    })

    res.json({
      success: true,
      task: data,
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

  clearPendingTaskNotifications(taskId).catch((notificationError) => {
    console.error('Delete task notification clear error:', notificationError)
  })

  res.json({
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

  res.json({
    success: true,
    task: updatedTask,
    checked: !alreadyDone,
    date,
  })
})

module.exports = router