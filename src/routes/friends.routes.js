const express = require('express')
const { z } = require('zod')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')
const { validateBody } = require('../middleware/validate')

const router = express.Router()

const sendRequestSchema = z.object({
  receiverId: z.string().uuid(),
})

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

router.get('/', authMiddleware, async (req, res) => {
  const userId = req.user.id

  const { data: requests, error } = await supabase
    .from('friend_requests')
    .select('*')
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    .order('created_at', { ascending: false })

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  const otherUserIds = [
    ...new Set(
      requests.map((request) =>
        request.sender_id === userId ? request.receiver_id : request.sender_id
      )
    ),
  ]

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

  const items = requests
    .map((request) => {
      const isSender = request.sender_id === userId
      const otherUserId = isSender ? request.receiver_id : request.sender_id
      const otherUser = usersMap[otherUserId]

      if (!otherUser) return null

      return {
        id: request.id,
        status: request.status,
        direction: isSender ? 'outgoing' : 'incoming',
        createdAt: request.created_at,
        user: otherUser,
      }
    })
    .filter(Boolean)

  res.json({
    success: true,
    requests: items,
  })
})

router.get('/search', authMiddleware, async (req, res) => {
  const userId = req.user.id

  const query = String(req.query.nickname || req.query.q || '')
    .trim()
    .replace(/[%_,]/g, '')
    .slice(0, 30)

  if (query.length < 2) {
    return res.json({
      success: true,
      users: [],
    })
  }

  const { data, error } = await supabase
    .from('users')
    .select(
      'id, display_name, first_name, username, app_nickname, avatar_url, telegram_avatar_url'
    )
    .neq('id', userId)
    .or(`app_nickname.ilike.${query}%,username.ilike.${query}%`)
    .limit(10)

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  res.json({
    success: true,
    users: Array.isArray(data) ? data.map(publicUser) : [],
  })
})

router.post(
  '/request',
  authMiddleware,
  validateBody(sendRequestSchema),
  async (req, res) => {
    const senderId = req.user.id
    const { receiverId } = req.body

    if (senderId === receiverId) {
      return res.status(400).json({
        success: false,
        error: 'CANNOT_ADD_YOURSELF',
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

    const { data: existingRequest, error: existingError } = await supabase
      .from('friend_requests')
      .select('*')
      .or(
        `and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`
      )
      .maybeSingle()

    if (existingError) {
      return res.status(500).json({
        success: false,
        error: existingError.message,
      })
    }

    if (existingRequest) {
      return res.status(409).json({
        success: false,
        error: 'REQUEST_ALREADY_EXISTS',
      })
    }

    const { data, error } = await supabase
      .from('friend_requests')
      .insert({
        sender_id: senderId,
        receiver_id: receiverId,
        status: 'pending',
      })
      .select()
      .single()

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      })
    }

    res.json({
      success: true,
      request: {
        id: data.id,
        status: data.status,
        direction: 'outgoing',
        createdAt: data.created_at,
        user: publicUser(receiver),
      },
    })
  }
)

router.patch('/:requestId/accept', authMiddleware, async (req, res) => {
  const userId = req.user.id
  const { requestId } = req.params

  const { data, error } = await supabase
    .from('friend_requests')
    .update({
      status: 'accepted',
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('receiver_id', userId)
    .eq('status', 'pending')
    .select()
    .single()

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  res.json({
    success: true,
    request: data,
  })
})

router.patch('/:requestId/reject', authMiddleware, async (req, res) => {
  const userId = req.user.id
  const { requestId } = req.params

  const { data, error } = await supabase
    .from('friend_requests')
    .update({
      status: 'rejected',
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .eq('receiver_id', userId)
    .eq('status', 'pending')
    .select()
    .single()

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  res.json({
    success: true,
    request: data,
  })
})

router.delete('/:requestId', authMiddleware, async (req, res) => {
  const userId = req.user.id
  const { requestId } = req.params

  const { error } = await supabase
    .from('friend_requests')
    .delete()
    .eq('id', requestId)
    .eq('sender_id', userId)

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    })
  }

  res.json({
    success: true,
  })
})

module.exports = router