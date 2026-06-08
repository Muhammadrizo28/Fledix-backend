const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')

const router = express.Router()

router.patch('/language', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { language } = req.body || {}

    if (language !== 'en' && language !== 'ru') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_LANGUAGE',
      })
    }

    const { data: user, error } = await supabase
      .from('users')
      .update({
        language,
      })
      .eq('id', userId)
      .select('id, language')
      .single()

    if (error || !user) {
      return res.status(400).json({
        success: false,
        error: error?.message || 'LANGUAGE_UPDATE_FAILED',
      })
    }

    return res.json({
      success: true,
      language: user.language,
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'LANGUAGE_UPDATE_FAILED',
    })
  }
})

module.exports = router