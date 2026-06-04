const jwt = require('jsonwebtoken')
const { supabase } = require('../services/supabaseClient')

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'AUTH_TOKEN_REQUIRED',
      })
    }

    const token = authHeader.split(' ')[1]

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (!decoded?.userId) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_TOKEN',
      })
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.userId)
      .single()

    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'USER_NOT_FOUND',
      })
    }

    req.user = user
    next()
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'INVALID_OR_EXPIRED_TOKEN',
    })
  }
}

module.exports = { authMiddleware }