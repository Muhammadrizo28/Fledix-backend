const express = require('express')
const { z } = require('zod')

const { supabase } = require('../services/supabaseClient')
const { validateBody } = require('../middleware/validate')

const router = express.Router()

const upsertUserSchema = z.object({
  telegram_id: z.string().min(1).max(50),
  username: z.string().max(100).optional().default(''),
  first_name: z.string().max(100).optional().default(''),
  last_name: z.string().max(100).optional().default(''),
  avatar_url: z.string().max(500).optional().default(''),
})

router.post('/upsert', validateBody(upsertUserSchema), async (req, res) => {
  const { telegram_id, username, first_name, last_name, avatar_url } = req.body

  const { data, error } = await supabase
    .from('users')
    .upsert(
      {
        telegram_id,
        username,
        first_name,
        last_name,
        avatar_url,
      },
      {
        onConflict: 'telegram_id',
      }
    )
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
    user: data,
  })
})

router.get('/:telegramId', async (req, res) => {
  const { telegramId } = req.params

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .single()

  if (error) {
    return res.status(404).json({
      success: false,
      error: 'User not found',
    })
  }

  res.json({
    success: true,
    user: data,
  })
})

module.exports = router