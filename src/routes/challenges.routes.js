const express = require('express')
const { z } = require('zod')

const { supabase } = require('../services/supabaseClient')
const { validateBody } = require('../middleware/validate')
const { authMiddleware } = require('../middleware/auth.middleware')

const {
  recordTaskCompletionEvent,
} = require('../services/challengeProgressService')

const router = express.Router()

const createChallengeSchema = z.object({
  receiverId: z.string().uuid(),

  title: z.string().min(1).max(150),
  description: z.string().max(1000).optional().default(''),
  date: z.string().max(20).optional().default(''),
  time: z.string().max(20).optional().default(''),

  repeat: z.array(z.any()).optional().default([]),
  subtaskArr: z.array(z.any()).optional().default([]),

  challengePrice: z.number().optional().default(0),
  startDate: z.string().optional().default(''),
  endDate: z.string().optional().default(''),
})

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

function publicUser(user) {
  return {
    id: user.id,
    name:
      user.display_name ||
      user.first_name ||
      user.app_nickname ||
      user.username ||
      'User',
    nickname: user.app_nickname || user.username || '',
    avatarUrl: user.telegram_avatar_url || user.avatar_url || '',
  }
}

function buildUserMap(users) {
  const map = {}

  users.forEach((user) => {
    map[user.id] = publicUser(user)
  })

  return map
}

async function addAxionToUser(userId, amount) {
  const value = Number(amount || 0)

  if (!Number.isFinite(value) || value <= 0) return

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, axion')
    .eq('id', userId)
    .single()

  if (userError || !user) return

  const currentAxion = Number(user.axion || 0)
  const nextAxion = currentAxion + value

  await supabase
    .from('users')
    .update({
      axion: nextAxion,
    })
    .eq('id', userId)
}

function parseDateString(value) {
  if (!value) return null

  const text = String(value).trim()

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
    const [day, month, year] = text.split('/').map(Number)

    const date = new Date(year, month - 1, day)
    date.setHours(23, 59, 59, 999)

    return date
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T23:59:59.999`)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const date = new Date(text)

  return Number.isNaN(date.getTime()) ? null : date
}

function isChallengeEndDatePassed(endDate) {
  const parsedEndDate = parseDateString(endDate)

  if (!parsedEndDate) return false

  return new Date().getTime() > parsedEndDate.getTime()
}

function buildChallengeResult(task) {
  const score = task.challenge_score || {}

  const senderScore = Number(score.sender || 0)
  const receiverScore = Number(score.receiver || 0)

  const senderId = task.challenge_sender
  const receiverId = task.challenge_receiver

  const stake = Number(task.challenge_price || 0)
  const fullPrize = stake * 2

  if (senderScore > receiverScore) {
    return {
      status: 'ended',
      isDraw: false,
      winnerUserId: senderId,
      loserUserId: receiverId,
      senderScore,
      receiverScore,
      prizeAxion: fullPrize,
      senderPrizeAxion: fullPrize,
      receiverPrizeAxion: 0,
      claimedBy: [],
      hiddenBy: [],
      endedAt: new Date().toISOString(),
    }
  }

  if (receiverScore > senderScore) {
    return {
      status: 'ended',
      isDraw: false,
      winnerUserId: receiverId,
      loserUserId: senderId,
      senderScore,
      receiverScore,
      prizeAxion: fullPrize,
      senderPrizeAxion: 0,
      receiverPrizeAxion: fullPrize,
      claimedBy: [],
      hiddenBy: [],
      endedAt: new Date().toISOString(),
    }
  }

  return {
    status: 'ended',
    isDraw: true,
    winnerUserId: null,
    loserUserId: null,
    senderScore,
    receiverScore,
    prizeAxion: stake,
    senderPrizeAxion: stake,
    receiverPrizeAxion: stake,
    claimedBy: [],
    hiddenBy: [],
    endedAt: new Date().toISOString(),
  }
}

async function finalizeChallengeIfNeeded(task) {
  if (!task) return null

  if (task.challenge_status !== 'accepted') return task

  if (task.challenge_result?.status === 'ended') return task

  if (!isChallengeEndDatePassed(task.end_date)) return task

  const originTaskId = task.challenge_origin_task_id || task.id
  const result = buildChallengeResult(task)

  const { data, error } = await supabase
    .from('tasks')
    .update({
      challenge_status: 'ended',
      challenge_result: result,
      updated_at: new Date().toISOString(),
    })
    .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)
    .select()

  if (error) {
    console.error('Finalize challenge error:', error.message)
    return task
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : task
}

function getPrizeForUser(task, userId) {
  const result = task.challenge_result || {}

  if (result.status !== 'ended') return 0

  if (task.challenge_sender === userId) {
    return Number(result.senderPrizeAxion || 0)
  }

  if (task.challenge_receiver === userId) {
    return Number(result.receiverPrizeAxion || 0)
  }

  return 0
}

function normalizeChallengeTask(task, currentUserId, usersMap) {
  const isSender = task.challenge_sender === currentUserId
  const otherUserId = isSender ? task.challenge_receiver : task.challenge_sender
  const otherUser = usersMap[otherUserId]

  if (!otherUser) return null

  return {
    id: task.id,

    title: task.title || '',
    description: task.description || '',
    tag: task.tag || '',
    date: task.date || '',
    time: task.time || '',

    repeat: Array.isArray(task.repeat) ? task.repeat : [],
    subtaskArr: Array.isArray(task.subtask_arr) ? task.subtask_arr : [],
    done: Array.isArray(task.done) ? task.done : [],

    frozen: Boolean(task.frozen),
    completed: Boolean(task.completed),

    challengeType: task.challenge_type || '',
    challengeStatus: task.challenge_status || '',

    challengeOriginTaskId:
      task.challenge_origin_task_id || task.challengeOriginTaskId || null,

    challengeDeleteRequestedBy:
      task.challenge_delete_requested_by ||
      task.challengeDeleteRequestedBy ||
      null,

    challengeSender: task.challenge_sender,
    challengeReceiver: task.challenge_receiver,

    challengePrice: task.challenge_price || 0,
    challengeResult: task.challenge_result || null,

    challengeScore: task.challenge_score || {
      sender: 0,
      receiver: 0,
    },

    challengeSenderDoneDates: Array.isArray(task.challenge_sender_done_dates)
      ? task.challenge_sender_done_dates
      : [],

    challengeReceiverDoneDates: Array.isArray(task.challenge_receiver_done_dates)
      ? task.challenge_receiver_done_dates
      : [],

    startDate: task.start_date || '',
    endDate: task.end_date || '',

    createdAt: task.created_at || '',
    updatedAt: task.updated_at || '',

    direction: isSender ? 'outgoing' : 'incoming',
    friend: otherUser,
  }
}

router.get('/friend-tasks', authMiddleware, async (req, res) => {
  const userId = req.user.id

  const { data: challengeTasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('challenge_type', 'friend')
    .or(`user_id.eq.${userId},challenge_receiver.eq.${userId}`)
    .order('created_at', { ascending: false })

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  const uniqueAcceptedTasks = []
  const usedOrigins = new Set()

  for (const task of challengeTasks || []) {
    if (task.challenge_status !== 'accepted') continue

    const originTaskId = task.challenge_origin_task_id || task.id

    if (usedOrigins.has(originTaskId)) continue

    usedOrigins.add(originTaskId)
    uniqueAcceptedTasks.push(task)
  }

  for (const task of uniqueAcceptedTasks) {
    await finalizeChallengeIfNeeded(task)
  }

  const { data: freshChallengeTasks, error: freshError } = await supabase
    .from('tasks')
    .select('*')
    .eq('challenge_type', 'friend')
    .or(`user_id.eq.${userId},challenge_receiver.eq.${userId}`)
    .order('created_at', { ascending: false })

  if (freshError) {
    return res.status(500).json({
      success: false,
      error: freshError.message,
    })
  }

  const finalChallengeTasks = freshChallengeTasks || []

  const visibleChallengeTasks = finalChallengeTasks.filter((task) => {
    if (task.challenge_status === 'rejected') return false

    const result = task.challenge_result || {}
    const hiddenBy = Array.isArray(result.hiddenBy) ? result.hiddenBy : []

    if (task.challenge_status === 'ended' && hiddenBy.includes(userId)) {
      return false
    }

    if (task.user_id === userId) return true

    return (
      task.challenge_receiver === userId &&
      task.challenge_status === 'pending'
    )
  })

  const otherUserIds = [
    ...new Set(
      visibleChallengeTasks.map((task) =>
        task.challenge_sender === userId
          ? task.challenge_receiver
          : task.challenge_sender
      )
    ),
  ].filter(Boolean)

  let usersMap = {}

  if (otherUserIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select(
        'id, display_name, first_name, username, app_nickname, avatar_url, telegram_avatar_url'
      )
      .in('id', otherUserIds)

    if (usersError) {
      return res.status(500).json({
        success: false,
        error: usersError.message,
      })
    }

    usersMap = buildUserMap(users || [])
  }

  const tasks = visibleChallengeTasks
    .map((task) => normalizeChallengeTask(task, userId, usersMap))
    .filter(Boolean)

  res.json({
    success: true,
    tasks,
  })
})

router.post(
  '/friend-tasks',
  authMiddleware,
  validateBody(createChallengeSchema),
  async (req, res) => {
    const senderId = req.user.id

    const {
      receiverId,
      title,
      description,
      date,
      time,
      repeat,
      subtaskArr,
      challengePrice,
      startDate,
      endDate,
    } = req.body

    const priceNumber = Number(challengePrice || 0)

    if (senderId === receiverId) {
      return res.status(400).json({
        success: false,
        error: 'CANNOT_CHALLENGE_YOURSELF',
      })
    }

    if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_CHALLENGE_PRICE',
      })
    }

    const { data: sender, error: senderError } = await supabase
      .from('users')
      .select('id, axion')
      .eq('id', senderId)
      .single()

    if (senderError || !sender) {
      return res.status(404).json({
        success: false,
        error: 'SENDER_NOT_FOUND',
      })
    }

    const senderAxion = Number(sender.axion || 0)

    if (priceNumber > senderAxion) {
      return res.status(400).json({
        success: false,
        error: 'NOT_ENOUGH_AXION',
      })
    }

    const { data: receiver, error: receiverError } = await supabase
      .from('users')
      .select(
        'id, display_name, first_name, username, app_nickname, avatar_url, telegram_avatar_url'
      )
      .eq('id', receiverId)
      .single()

    if (receiverError || !receiver) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
      })
    }

    const nextSenderAxion = senderAxion - priceNumber

    const { error: axionError } = await supabase
      .from('users')
      .update({
        axion: nextSenderAxion,
      })
      .eq('id', senderId)

    if (axionError) {
      return res.status(500).json({
        success: false,
        error: axionError.message,
      })
    }

    const { data, error: insertError } = await supabase
      .from('tasks')
      .insert({
        user_id: senderId,

        title,
        description,
        tag: 'Friend Challenge',
        date,
        time,

        repeat,
        subtask_arr: normalizeSubtasks(subtaskArr),
        done: [],

        frozen: false,
        completed: false,

        challenge_type: 'friend',
        challenge_status: 'pending',

        challenge_origin_task_id: null,
        challenge_delete_requested_by: null,

        challenge_sender: senderId,
        challenge_receiver: receiverId,

        challenge_price: priceNumber,
        challenge_result: null,

        challenge_score: {
          sender: 0,
          receiver: 0,
        },

        challenge_sender_done_dates: [],
        challenge_receiver_done_dates: [],

        start_date: startDate,
        end_date: endDate,
      })
      .select()
      .single()

    if (insertError) {
      await supabase
        .from('users')
        .update({
          axion: senderAxion,
        })
        .eq('id', senderId)

      return res.status(500).json({
        success: false,
        error: insertError.message,
      })
    }

    const { data: updatedTask, error: originError } = await supabase
      .from('tasks')
      .update({
        challenge_origin_task_id: data.id,
      })
      .eq('id', data.id)
      .select()
      .single()

    if (originError) {
      await supabase.from('tasks').delete().eq('id', data.id)

      await supabase
        .from('users')
        .update({
          axion: senderAxion,
        })
        .eq('id', senderId)

      return res.status(500).json({
        success: false,
        error: originError.message,
      })
    }

    res.json({
      success: true,
      axion: nextSenderAxion,
      task: {
        id: updatedTask.id,

        title: updatedTask.title || '',
        description: updatedTask.description || '',
        tag: updatedTask.tag || '',
        date: updatedTask.date || '',
        time: updatedTask.time || '',

        repeat: updatedTask.repeat || [],
        subtaskArr: updatedTask.subtask_arr || [],
        done: updatedTask.done || [],

        challengeType: updatedTask.challenge_type,
        challengeStatus: updatedTask.challenge_status,

        challengeOriginTaskId: updatedTask.challenge_origin_task_id,
        challengeDeleteRequestedBy: updatedTask.challenge_delete_requested_by,

        challengeSender: updatedTask.challenge_sender,
        challengeReceiver: updatedTask.challenge_receiver,

        challengePrice: updatedTask.challenge_price || 0,
        challengeResult: updatedTask.challenge_result || null,

        challengeScore: updatedTask.challenge_score || {
          sender: 0,
          receiver: 0,
        },

        challengeSenderDoneDates: updatedTask.challenge_sender_done_dates || [],
        challengeReceiverDoneDates:
          updatedTask.challenge_receiver_done_dates || [],

        startDate: updatedTask.start_date || '',
        endDate: updatedTask.end_date || '',

        createdAt: updatedTask.created_at || '',

        direction: 'outgoing',
        friend: publicUser(receiver),
      },
    })
  }
)

router.patch('/friend-tasks/:taskId/accept', authMiddleware, async (req, res) => {
  const receiverId = req.user.id
  const { taskId } = req.params

  const { data: originalTask, error: findError } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .eq('challenge_receiver', receiverId)
    .eq('challenge_status', 'pending')
    .single()

  if (findError || !originalTask) {
    return res.status(404).json({
      success: false,
      error: 'CHALLENGE_TASK_NOT_FOUND',
    })
  }

  const priceNumber = Number(originalTask.challenge_price || 0)

  if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_CHALLENGE_PRICE',
    })
  }

  const { data: receiver, error: receiverError } = await supabase
    .from('users')
    .select('id, axion')
    .eq('id', receiverId)
    .single()

  if (receiverError || !receiver) {
    return res.status(404).json({
      success: false,
      error: 'RECEIVER_NOT_FOUND',
    })
  }

  const receiverAxion = Number(receiver.axion || 0)

  if (priceNumber > receiverAxion) {
    return res.status(400).json({
      success: false,
      error: 'NOT_ENOUGH_AXION',
    })
  }

  const nextReceiverAxion = receiverAxion - priceNumber
  const originTaskId = originalTask.challenge_origin_task_id || originalTask.id

  const rollbackReceiverAxion = async () => {
    await supabase
      .from('users')
      .update({
        axion: receiverAxion,
      })
      .eq('id', receiverId)
  }

  const rollbackChallengeStatus = async () => {
    await supabase
      .from('tasks')
      .update({
        challenge_status: 'pending',
        challenge_delete_requested_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId)
  }

  const { error: axionUpdateError } = await supabase
    .from('users')
    .update({
      axion: nextReceiverAxion,
    })
    .eq('id', receiverId)

  if (axionUpdateError) {
    return res.status(500).json({
      success: false,
      error: axionUpdateError.message,
    })
  }

  const { data: acceptedTask, error: updateError } = await supabase
    .from('tasks')
    .update({
      challenge_status: 'accepted',
      challenge_origin_task_id: originTaskId,
      challenge_delete_requested_by: null,
      challenge_result: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .eq('challenge_receiver', receiverId)
    .eq('challenge_status', 'pending')
    .select()
    .single()

  if (updateError) {
    await rollbackReceiverAxion()

    return res.status(500).json({
      success: false,
      error: updateError.message,
    })
  }

  const { data: existingReceiverTask, error: existingError } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', receiverId)
    .eq('challenge_origin_task_id', originTaskId)
    .maybeSingle()

  if (existingError) {
    await rollbackChallengeStatus()
    await rollbackReceiverAxion()

    return res.status(500).json({
      success: false,
      error: existingError.message,
    })
  }

  let receiverTask = existingReceiverTask

  if (!existingReceiverTask) {
    const { data: createdReceiverTask, error: insertError } = await supabase
      .from('tasks')
      .insert({
        user_id: receiverId,

        title: originalTask.title,
        description: originalTask.description || '',
        tag: originalTask.tag || 'Friend Challenge',
        date: originalTask.date || originalTask.start_date || '',
        time: originalTask.time || '',

        repeat: originalTask.repeat || [],
        subtask_arr: originalTask.subtask_arr || [],
        done: [],

        frozen: false,
        completed: false,

        challenge_type: 'friend',
        challenge_status: 'accepted',

        challenge_origin_task_id: originTaskId,
        challenge_delete_requested_by: null,

        challenge_sender: originalTask.challenge_sender,
        challenge_receiver: originalTask.challenge_receiver,

        challenge_price: priceNumber,
        challenge_result: null,

        challenge_score: originalTask.challenge_score || {
          sender: 0,
          receiver: 0,
        },

        challenge_sender_done_dates:
          originalTask.challenge_sender_done_dates || [],

        challenge_receiver_done_dates:
          originalTask.challenge_receiver_done_dates || [],

        start_date: originalTask.start_date || '',
        end_date: originalTask.end_date || '',
      })
      .select()
      .single()

    if (insertError) {
      await rollbackChallengeStatus()
      await rollbackReceiverAxion()

      return res.status(500).json({
        success: false,
        error: insertError.message,
      })
    }

    receiverTask = createdReceiverTask
  }

  res.json({
    success: true,
    axion: nextReceiverAxion,
    task: acceptedTask,
    receiverTask,
  })
})

router.patch('/friend-tasks/:taskId/reject', authMiddleware, async (req, res) => {
  const receiverId = req.user.id
  const { taskId } = req.params

  const { data: task, error: findError } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .eq('challenge_receiver', receiverId)
    .eq('challenge_status', 'pending')
    .single()

  if (findError || !task) {
    return res.status(404).json({
      success: false,
      error: 'CHALLENGE_TASK_NOT_FOUND',
    })
  }

  const { data, error } = await supabase
    .from('tasks')
    .update({
      challenge_status: 'rejected',
      challenge_delete_requested_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .eq('challenge_receiver', receiverId)
    .eq('challenge_status', 'pending')
    .select()
    .single()

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  await addAxionToUser(task.challenge_sender, task.challenge_price)

  res.json({
    success: true,
    task: data,
  })
})

router.delete('/friend-tasks/:taskId', authMiddleware, async (req, res) => {
  const userId = req.user.id
  const { taskId } = req.params

  const { data: task, error: findError } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .eq('challenge_type', 'friend')
    .single()

  if (findError || !task) {
    return res.status(404).json({
      success: false,
      error: 'CHALLENGE_TASK_NOT_FOUND',
    })
  }

  const hasAccess =
    task.user_id === userId ||
    task.challenge_sender === userId ||
    task.challenge_receiver === userId

  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
    })
  }

  if (task.challenge_status === 'pending') {
    if (task.challenge_sender !== userId) {
      return res.status(403).json({
        success: false,
        error: 'ONLY_SENDER_CAN_CANCEL_PENDING_CHALLENGE',
      })
    }

    const { data: deletedTask, error: deleteError } = await supabase
      .from('tasks')
      .delete()
      .eq('id', taskId)
      .eq('challenge_status', 'pending')
      .select()
      .single()

    if (deleteError) {
      return res.status(500).json({
        success: false,
        error: deleteError.message,
      })
    }

    await addAxionToUser(task.challenge_sender, task.challenge_price)

    return res.json({
      success: true,
      cancelled: true,
      deletedTask,
    })
  }

  if (task.challenge_status !== 'accepted') {
    return res.status(400).json({
      success: false,
      error: 'ONLY_ACCEPTED_CHALLENGE_CAN_BE_DELETE_REQUESTED',
    })
  }

  const originTaskId = task.challenge_origin_task_id || task.id

  const { data, error } = await supabase
    .from('tasks')
    .update({
      challenge_status: 'delete_requested',
      challenge_delete_requested_by: userId,
      updated_at: new Date().toISOString(),
    })
    .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)
    .select()

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

router.patch(
  '/friend-tasks/:taskId/delete/accept',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id
    const { taskId } = req.params

    const { data: task, error: findError } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('challenge_type', 'friend')
      .eq('challenge_status', 'delete_requested')
      .single()

    if (findError || !task) {
      return res.status(404).json({
        success: false,
        error: 'DELETE_REQUEST_NOT_FOUND',
      })
    }

    if (task.challenge_delete_requested_by === userId) {
      return res.status(403).json({
        success: false,
        error: 'REQUESTER_CANNOT_CONFIRM_DELETE',
      })
    }

    const hasAccess =
      task.user_id === userId ||
      task.challenge_sender === userId ||
      task.challenge_receiver === userId

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
      })
    }

    const originTaskId = task.challenge_origin_task_id || task.id

    const { data, error } = await supabase
      .from('tasks')
      .delete()
      .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)
      .select()

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      })
    }

    res.json({
      success: true,
      deletedTasks: data,
    })
  }
)

router.patch(
  '/friend-tasks/:taskId/delete/reject',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id
    const { taskId } = req.params

    const { data: task, error: findError } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('challenge_type', 'friend')
      .eq('challenge_status', 'delete_requested')
      .single()

    if (findError || !task) {
      return res.status(404).json({
        success: false,
        error: 'DELETE_REQUEST_NOT_FOUND',
      })
    }

    if (task.challenge_delete_requested_by === userId) {
      return res.status(403).json({
        success: false,
        error: 'REQUESTER_CANNOT_REJECT_OWN_DELETE_REQUEST',
      })
    }

    const hasAccess =
      task.user_id === userId ||
      task.challenge_sender === userId ||
      task.challenge_receiver === userId

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
      })
    }

    const originTaskId = task.challenge_origin_task_id || task.id

    const { data, error } = await supabase
      .from('tasks')
      .update({
        challenge_status: 'accepted',
        challenge_delete_requested_by: null,
        updated_at: new Date().toISOString(),
      })
      .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)
      .select()

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
  }
)

router.patch(
  '/friend-tasks/:taskId/delete/cancel',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id
    const { taskId } = req.params

    const { data: task, error: findError } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('challenge_type', 'friend')
      .eq('challenge_status', 'delete_requested')
      .single()

    if (findError || !task) {
      return res.status(404).json({
        success: false,
        error: 'DELETE_REQUEST_NOT_FOUND',
      })
    }

    if (task.challenge_delete_requested_by !== userId) {
      return res.status(403).json({
        success: false,
        error: 'ONLY_REQUESTER_CAN_CANCEL_DELETE_REQUEST',
      })
    }

    const originTaskId = task.challenge_origin_task_id || task.id

    const { data, error } = await supabase
      .from('tasks')
      .update({
        challenge_status: 'accepted',
        challenge_delete_requested_by: null,
        updated_at: new Date().toISOString(),
      })
      .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)
      .select()

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
  }
)

router.patch('/friend-tasks/:taskId/done', authMiddleware, async (req, res) => {
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
    .eq('challenge_type', 'friend')
    .single()

  if (findError || !task) {
    return res.status(404).json({
      success: false,
      error: 'CHALLENGE_TASK_NOT_FOUND',
    })
  }

  if (task.challenge_status !== 'accepted') {
    return res.status(400).json({
      success: false,
      error: 'ONLY_ACCEPTED_CHALLENGE_CAN_BE_COMPLETED',
    })
  }

  const isSender = task.challenge_sender === userId
  const isReceiver = task.challenge_receiver === userId

  if (!isSender && !isReceiver) {
    return res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
    })
  }

  const originTaskId = task.challenge_origin_task_id || task.id

  const senderDates = Array.isArray(task.challenge_sender_done_dates)
    ? task.challenge_sender_done_dates
    : []

  const receiverDates = Array.isArray(task.challenge_receiver_done_dates)
    ? task.challenge_receiver_done_dates
    : []

  const currentUserDoneDates = isSender ? senderDates : receiverDates
  const alreadyDone = currentUserDoneDates.includes(date)

  const nextSenderDates = isSender
    ? alreadyDone
      ? senderDates.filter((item) => item !== date)
      : [...senderDates, date]
    : senderDates

  const nextReceiverDates = isReceiver
    ? alreadyDone
      ? receiverDates.filter((item) => item !== date)
      : [...receiverDates, date]
    : receiverDates

  const nextScore = {
    sender: nextSenderDates.length,
    receiver: nextReceiverDates.length,
  }

  const { error: sharedUpdateError } = await supabase
    .from('tasks')
    .update({
      challenge_sender_done_dates: nextSenderDates,
      challenge_receiver_done_dates: nextReceiverDates,
      challenge_score: nextScore,
      updated_at: new Date().toISOString(),
    })
    .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)

  if (sharedUpdateError) {
    return res.status(500).json({
      success: false,
      error: sharedUpdateError.message,
    })
  }

  const currentDone = Array.isArray(task.done) ? task.done : []

  const nextDone = alreadyDone
    ? currentDone.filter((item) => item !== date)
    : [...currentDone, date]

  const { data: updatedUserTask, error: userTaskUpdateError } = await supabase
    .from('tasks')
    .update({
      done: nextDone,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)
    .select()
    .single()

  if (userTaskUpdateError) {
    return res.status(500).json({
      success: false,
      error: userTaskUpdateError.message,
    })
  }

  if (!alreadyDone) {
    const eventResult = await recordTaskCompletionEvent({
      userId,
      taskId: updatedUserTask.id,
      completionDate: date,
      taskType: 'friend_challenge',
      source: 'friend_challenge_checkbox',
    })

    if (!eventResult?.success) {
      console.error(
        'Friend challenge completion event error:',
        eventResult?.error
      )
    }
  }

  res.json({
    success: true,
    task: updatedUserTask,
    checked: !alreadyDone,
    date,
  })
})

router.patch(
  '/friend-tasks/:taskId/reward/claim',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id
    const { taskId } = req.params

    const { data: task, error: findError } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('challenge_type', 'friend')
      .single()

    if (findError || !task) {
      return res.status(404).json({
        success: false,
        error: 'CHALLENGE_TASK_NOT_FOUND',
      })
    }

    const hasAccess =
      task.user_id === userId ||
      task.challenge_sender === userId ||
      task.challenge_receiver === userId

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
      })
    }

    if (task.challenge_status !== 'ended') {
      return res.status(400).json({
        success: false,
        error: 'CHALLENGE_NOT_ENDED',
      })
    }

    const result = task.challenge_result || {}

    if (result.status !== 'ended') {
      return res.status(400).json({
        success: false,
        error: 'CHALLENGE_RESULT_NOT_FOUND',
      })
    }

    const claimedBy = Array.isArray(result.claimedBy) ? result.claimedBy : []

    if (claimedBy.includes(userId)) {
      return res.json({
        success: true,
        alreadyClaimed: true,
        claimedAxion: 0,
        result,
      })
    }

    const originTaskId = task.challenge_origin_task_id || task.id
    const claimedAxion = getPrizeForUser(task, userId)

    const nextResult = {
      ...result,
      claimedBy: [...claimedBy, userId],
      hiddenBy: Array.isArray(result.hiddenBy) ? result.hiddenBy : [],
    }

    const { error: updateError } = await supabase
      .from('tasks')
      .update({
        challenge_result: nextResult,
        updated_at: new Date().toISOString(),
      })
      .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)

    if (updateError) {
      return res.status(500).json({
        success: false,
        error: updateError.message,
      })
    }

    if (claimedAxion > 0) {
      await addAxionToUser(userId, claimedAxion)
    }

    res.json({
      success: true,
      alreadyClaimed: false,
      claimedAxion,
      result: nextResult,
    })
  }
)

router.patch(
  '/friend-tasks/:taskId/ended/hide',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id
    const { taskId } = req.params

    const { data: task, error: findError } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('challenge_type', 'friend')
      .single()

    if (findError || !task) {
      return res.status(404).json({
        success: false,
        error: 'CHALLENGE_TASK_NOT_FOUND',
      })
    }

    const hasAccess =
      task.user_id === userId ||
      task.challenge_sender === userId ||
      task.challenge_receiver === userId

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
      })
    }

    if (task.challenge_status !== 'ended') {
      return res.status(400).json({
        success: false,
        error: 'ONLY_ENDED_CHALLENGE_CAN_BE_HIDDEN',
      })
    }

    const result = task.challenge_result || {}

    if (result.status !== 'ended') {
      return res.status(400).json({
        success: false,
        error: 'CHALLENGE_RESULT_NOT_FOUND',
      })
    }

    const claimedBy = Array.isArray(result.claimedBy) ? result.claimedBy : []
    const hiddenBy = Array.isArray(result.hiddenBy) ? result.hiddenBy : []

    const alreadyClaimed = claimedBy.includes(userId)
    const alreadyHidden = hiddenBy.includes(userId)

    const claimedAxion = alreadyClaimed ? 0 : getPrizeForUser(task, userId)

    const nextResult = {
      ...result,
      claimedBy: alreadyClaimed ? claimedBy : [...claimedBy, userId],
      hiddenBy: alreadyHidden ? hiddenBy : [...hiddenBy, userId],
    }

    const originTaskId = task.challenge_origin_task_id || task.id

    const { error: updateError } = await supabase
      .from('tasks')
      .update({
        challenge_result: nextResult,
        updated_at: new Date().toISOString(),
      })
      .or(`id.eq.${originTaskId},challenge_origin_task_id.eq.${originTaskId}`)

    if (updateError) {
      return res.status(500).json({
        success: false,
        error: updateError.message,
      })
    }

    if (claimedAxion > 0) {
      await addAxionToUser(userId, claimedAxion)
    }

    res.json({
      success: true,
      hidden: true,
      claimedAxion,
      result: nextResult,
    })
  }
)

module.exports = router