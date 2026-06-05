const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { z } = require('zod')

const { supabase } = require('../services/supabaseClient')
const { validateBody } = require('../middleware/validate')
const { authMiddleware } = require('../middleware/auth.middleware')
const { verifyTelegramInitData } = require('../utils/telegramAuth')

const { sendOtpEmail } = require('../services/emailService')

const router = express.Router()

const OTP_COOLDOWN_WINDOW_MS = 24 * 60 * 60 * 1000

function createToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      telegramId: user.telegram_id || null,
      email: user.email || null,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '30d',
    }
  )
}

function normalizeEmail(email) {
  if (!email) return ''
  return String(email).trim().toLowerCase()
}

function normalizeNickname(nickname) {
  return String(nickname)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}


function normalizeTelegramUsername(username, telegramId) {
  const cleanUsername = String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, 40)

  return cleanUsername || `tg_${telegramId}`
}

function publicUser(user) {
  return {
    id: user.id,

    telegram_id: user.telegram_id || null,
    telegramId: user.telegram_id || null,

    email: user.email || null,
    email_verified: Boolean(user.email_verified),
    emailVerified: Boolean(user.email_verified),

    username: user.username || '',
    app_nickname: user.app_nickname || '',
    appNickname: user.app_nickname || '',

    first_name: user.first_name || '',
    firstName: user.first_name || '',

    last_name: user.last_name || '',
    lastName: user.last_name || '',

    display_name:
      user.display_name ||
      user.first_name ||
      user.app_nickname ||
      user.username ||
      user.email ||
      'User',

    displayName:
      user.display_name ||
      user.first_name ||
      user.app_nickname ||
      user.username ||
      user.email ||
      'User',

    avatar_url: user.telegram_id ? user.telegram_avatar_url || '' : '',
    avatarUrl: user.telegram_id ? user.telegram_avatar_url || '' : '',

    telegram_avatar_url: user.telegram_avatar_url || '',
    telegramAvatarUrl: user.telegram_avatar_url || '',

    axion: user.axion || 0,
    auth_provider: user.auth_provider || 'web',
    authProvider: user.auth_provider || 'web',

    created_at: user.created_at,
    createdAt: user.created_at,
  }
}

async function getUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email)

  if (!normalizedEmail) return null

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (error) return null

  return data
}

async function getUserByNickname(nickname) {
  const normalizedNickname = normalizeNickname(nickname)

  if (!normalizedNickname) return null

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('app_nickname', normalizedNickname)
    .maybeSingle()

  if (error) return null

  return data
}

async function getUserByTelegramId(telegramId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .maybeSingle()

  if (error) return null

  return data
}

async function getFreshUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single()

  if (error || !data) return null

  return data
}

async function ensureEmailIsFree(email, currentUserId = null) {
  const normalizedEmail = normalizeEmail(email)
  const existingUser = await getUserByEmail(normalizedEmail)

  if (existingUser && existingUser.id !== currentUserId) {
    return {
      success: false,
      error: 'EMAIL_ALREADY_EXISTS',
    }
  }

  return {
    success: true,
  }
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 999999))
}

function getOtpCooldownSeconds(previousCodeCount) {
  if (previousCodeCount <= 0) return 0
  if (previousCodeCount === 1) return 60
  if (previousCodeCount === 2) return 5 * 60

  return 30 * 60
}

function getRemainingSeconds(lastCreatedAt, cooldownSeconds) {
  const lastSentAt = new Date(lastCreatedAt).getTime()
  const nextAllowedAt = lastSentAt + cooldownSeconds * 1000
  const remainingMs = nextAllowedAt - Date.now()

  return Math.max(0, Math.ceil(remainingMs / 1000))
}

async function checkOtpCooldown({ userId, purpose }) {
  const since = new Date(Date.now() - OTP_COOLDOWN_WINDOW_MS).toISOString()

  const { data, error } = await supabase
    .from('auth_login_codes')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .gte('created_at', since)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  const previousCodes = Array.isArray(data) ? data : []
  const previousCodeCount = previousCodes.length

  if (previousCodeCount === 0) {
    return {
      allowed: true,
      previousCodeCount,
      retryAfterSeconds: 0,
    }
  }

  const cooldownSeconds = getOtpCooldownSeconds(previousCodeCount)
  const latestCode = previousCodes[0]

  const retryAfterSeconds = getRemainingSeconds(
    latestCode.created_at,
    cooldownSeconds
  )

  if (retryAfterSeconds > 0) {
    return {
      allowed: false,
      previousCodeCount,
      retryAfterSeconds,
    }
  }

  return {
    allowed: true,
    previousCodeCount,
    retryAfterSeconds: 0,
  }
}

function createOtpCooldownError(retryAfterSeconds) {
  const error = new Error('OTP_COOLDOWN')
  error.status = 429
  error.retryAfterSeconds = retryAfterSeconds
  return error
}

function handleOtpError(res, error) {
  if (error.message === 'OTP_COOLDOWN') {
    return res.status(429).json({
      success: false,
      error: 'OTP_COOLDOWN',
      retryAfterSeconds: error.retryAfterSeconds || 60,
    })
  }

  return res.status(500).json({
    success: false,
    error: error.message,
  })
}

async function createEmailCode({ user, purpose, toEmail, payload = {} }) {
  const cooldown = await checkOtpCooldown({
    userId: user.id,
    purpose,
  })

  if (!cooldown.allowed) {
    throw createOtpCooldownError(cooldown.retryAfterSeconds)
  }

  const code = generateOtpCode()
  const codeHash = await bcrypt.hash(code, 12)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  await supabase
    .from('auth_login_codes')
    .update({
      used: true,
    })
    .eq('user_id', user.id)
    .eq('purpose', purpose)
    .eq('used', false)

  const { data, error } = await supabase
    .from('auth_login_codes')
    .insert({
      user_id: user.id,
      code_hash: codeHash,
      purpose,
      used: false,
      expires_at: expiresAt,
      payload,
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(error.message)
  }

  await sendOtpEmail({
    to: toEmail,
    code,
    purpose,
  })

  const nextCooldownSeconds = getOtpCooldownSeconds(
    cooldown.previousCodeCount + 1
  )

  return {
    sessionId: data.id,
    nextCooldownSeconds,
    devCode: process.env.NODE_ENV === 'development' ? code : undefined,
  }
}

async function createLoginCode(user) {
  const result = await createEmailCode({
    user,
    purpose: 'login',
    toEmail: user.email,
    payload: {},
  })

  return {
    loginSessionId: result.sessionId,
    nextCooldownSeconds: result.nextCooldownSeconds,
    devCode: result.devCode,
  }
}

async function createRegistrationCode(user) {
  const result = await createEmailCode({
    user,
    purpose: 'registration',
    toEmail: user.email,
    payload: {},
  })

  return {
    loginSessionId: result.sessionId,
    nextCooldownSeconds: result.nextCooldownSeconds,
    devCode: result.devCode,
  }
}

async function verifyCodeSession({ sessionId, purposes, code }) {
  const purposeList = Array.isArray(purposes) ? purposes : [purposes]

  const { data: codeRow, error } = await supabase
    .from('auth_login_codes')
    .select('*, user:user_id(*)')
    .eq('id', sessionId)
    .in('purpose', purposeList)
    .eq('used', false)
    .maybeSingle()

  if (error || !codeRow) {
    return {
      success: false,
      status: 401,
      error: 'INVALID_OR_USED_CODE',
    }
  }

  const expiresAt = new Date(codeRow.expires_at).getTime()

  if (Date.now() > expiresAt) {
    return {
      success: false,
      status: 401,
      error: 'CODE_EXPIRED',
    }
  }

  const isCodeValid = await bcrypt.compare(String(code), codeRow.code_hash)

  if (!isCodeValid) {
    return {
      success: false,
      status: 401,
      error: 'INVALID_CODE',
    }
  }

  await supabase
    .from('auth_login_codes')
    .update({
      used: true,
    })
    .eq('id', sessionId)

  return {
    success: true,
    purpose: codeRow.purpose,
    codeRow,
    user: codeRow.user,
    payload: codeRow.payload || {},
  }
}

async function requestLinkEmail({ currentUser, email }) {
  const freshUser = await getFreshUser(currentUser.id)

  if (!freshUser) {
    return {
      success: false,
      status: 404,
      error: 'USER_NOT_FOUND',
    }
  }

  if (freshUser.email && freshUser.email_verified) {
    return {
      success: false,
      status: 400,
      error: 'EMAIL_ALREADY_LINKED',
    }
  }

  const normalizedEmail = normalizeEmail(email)

  const emailCheck = await ensureEmailIsFree(normalizedEmail, freshUser.id)

  if (!emailCheck.success) {
    return {
      success: false,
      status: 409,
      error: emailCheck.error,
    }
  }

  const result = await createEmailCode({
    user: freshUser,
    purpose: 'link_email',
    toEmail: normalizedEmail,
    payload: {
      email: normalizedEmail,
    },
  })

  return {
    success: true,
    requiresCode: true,
    linkEmailSessionId: result.sessionId,
    nextCooldownSeconds: result.nextCooldownSeconds,
    devCode: result.devCode,
  }
}

const registerSchema = z.object({
  name: z.string().min(1).max(100),
  nickname: z.string().min(3).max(40),
  email: z.string().email().optional().or(z.literal('')).default(''),
  password: z.string().min(8).max(100),
})

const loginSchema = z.object({
  login: z.string().min(1).max(150).optional(),
  email: z.string().min(1).max(150).optional(),
  password: z.string().min(1).max(100),
})

const confirmLoginSchema = z.object({
  loginSessionId: z.string().uuid(),
  code: z.string().min(4).max(10),
})

const telegramSchema = z.object({
  initData: z.string().min(1),
})

const linkEmailRequestSchema = z.object({
  email: z.string().email(),
})

const linkEmailConfirmSchema = z.object({
  linkEmailSessionId: z.string().uuid(),
  code: z.string().min(4).max(10),
})

const changeEmailRequestSchema = z.object({
  newEmail: z.string().email(),
  password: z.string().min(1).max(100),
})

const changeEmailConfirmSchema = z.object({
  changeEmailSessionId: z.string().uuid(),
  code: z.string().min(4).max(10),
})

const changePasswordRequestSchema = z.object({})

const changePasswordConfirmSchema = z.object({
  changePasswordSessionId: z.string().uuid(),
  code: z.string().min(4).max(10),
  newPassword: z.string().min(8).max(100),
})

router.post('/register', validateBody(registerSchema), async (req, res) => {
  try {
    const { name, nickname, email, password } = req.body

    const normalizedNickname = normalizeNickname(nickname)
    const normalizedEmail = normalizeEmail(email)

    const existingNickname = await getUserByNickname(normalizedNickname)

    const existingEmail = normalizedEmail
      ? await getUserByEmail(normalizedEmail)
      : null

    const passwordHash = await bcrypt.hash(password, 12)

    if (existingEmail && !existingEmail.email_verified) {
      if (existingNickname && existingNickname.id !== existingEmail.id) {
        return res.status(409).json({
          success: false,
          error: 'NICKNAME_ALREADY_EXISTS',
        })
      }

      const { data: updatedPendingUser, error: updateError } = await supabase
        .from('users')
        .update({
          display_name: name.trim(),
          app_nickname: normalizedNickname,
          password_hash: passwordHash,
          auth_provider: 'web_email',
          email_verified: false,
        })
        .eq('id', existingEmail.id)
        .select()
        .single()

      if (updateError) {
        return res.status(500).json({
          success: false,
          error: updateError.message,
        })
      }

      const { loginSessionId, nextCooldownSeconds } =
        await createRegistrationCode(updatedPendingUser)

      return res.json({
        success: true,
        requiresCode: true,
        loginSessionId,
        nextCooldownSeconds,
        message: 'OTP_CODE_SENT',
        pendingRegistration: true,
      })
    }

    if (existingNickname) {
      const samePendingEmail =
        normalizedEmail &&
        !existingNickname.email_verified &&
        normalizeEmail(existingNickname.email) === normalizedEmail

      if (samePendingEmail) {
        const { data: updatedPendingUser, error: updateError } = await supabase
          .from('users')
          .update({
            display_name: name.trim(),
            password_hash: passwordHash,
            auth_provider: 'web_email',
            email_verified: false,
          })
          .eq('id', existingNickname.id)
          .select()
          .single()

        if (updateError) {
          return res.status(500).json({
            success: false,
            error: updateError.message,
          })
        }

        const { loginSessionId, nextCooldownSeconds } =
          await createRegistrationCode(updatedPendingUser)

        return res.json({
          success: true,
          requiresCode: true,
          loginSessionId,
          nextCooldownSeconds,
          message: 'OTP_CODE_SENT',
          pendingRegistration: true,
        })
      }

      return res.status(409).json({
        success: false,
        error: 'NICKNAME_ALREADY_EXISTS',
      })
    }

    if (existingEmail) {
      return res.status(409).json({
        success: false,
        error: 'EMAIL_ALREADY_EXISTS',
      })
    }

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        display_name: name.trim(),
        app_nickname: normalizedNickname,
        email: normalizedEmail || null,
        password_hash: passwordHash,
        auth_provider: normalizedEmail ? 'web_email' : 'web',
        email_verified: false,
      })
      .select()
      .single()

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      })
    }

    if (user.email) {
      const { loginSessionId, nextCooldownSeconds } =
        await createRegistrationCode(user)

      return res.json({
        success: true,
        requiresCode: true,
        loginSessionId,
        nextCooldownSeconds,
        message: 'OTP_CODE_SENT',
      })
    }

    const token = createToken(user)

    res.json({
      success: true,
      requiresCode: false,
      token,
      user: publicUser(user),
    })
  } catch (error) {
    return handleOtpError(res, error)
  }
})

router.post('/login', validateBody(loginSchema), async (req, res) => {
  try {
    const loginValue = req.body.login || req.body.email
    const { password } = req.body

    if (!loginValue) {
      return res.status(400).json({
        success: false,
        error: 'LOGIN_REQUIRED',
      })
    }

    const isEmail = loginValue.includes('@')

    const user = isEmail
      ? await getUserByEmail(loginValue)
      : await getUserByNickname(loginValue)

    if (!user || !user.password_hash) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_LOGIN_OR_PASSWORD',
      })
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash)

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_LOGIN_OR_PASSWORD',
      })
    }

    if (user.email) {
      const codeResult = user.email_verified
        ? await createLoginCode(user)
        : await createRegistrationCode(user)

      return res.json({
        success: true,
        requiresCode: true,
        loginSessionId: codeResult.loginSessionId,
        nextCooldownSeconds: codeResult.nextCooldownSeconds,
        message: 'OTP_CODE_SENT',
        pendingRegistration: !user.email_verified,
      })
    }

    const token = createToken(user)

    res.json({
      success: true,
      requiresCode: false,
      token,
      user: publicUser(user),
    })
  } catch (error) {
    return handleOtpError(res, error)
  }
})

router.post(
  '/login/confirm-code',
  validateBody(confirmLoginSchema),
  async (req, res) => {
    try {
      const { loginSessionId, code } = req.body

      const result = await verifyCodeSession({
        sessionId: loginSessionId,
        purposes: ['login', 'registration'],
        code,
      })

      if (!result.success) {
        return res.status(result.status).json({
          success: false,
          error: result.error,
        })
      }

      const user = result.user

      if (result.purpose === 'registration') {
        await supabase
          .from('users')
          .update({
            email_verified: true,
          })
          .eq('id', user.id)
      }

      if (result.purpose === 'login' && user.email && !user.email_verified) {
        await supabase
          .from('users')
          .update({
            email_verified: true,
          })
          .eq('id', user.id)
      }

      const updatedUser = await getFreshUser(user.id)
      const token = createToken(updatedUser || user)

      res.json({
        success: true,
        token,
        user: publicUser(updatedUser || user),
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      })
    }
  }
)

router.post('/telegram', validateBody(telegramSchema), async (req, res) => {
  try {
    const { initData } = req.body

    const result = verifyTelegramInitData(
      initData,
      process.env.TELEGRAM_BOT_TOKEN
    )

    if (!result.valid) {
      return res.status(401).json({
        success: false,
        error: result.error,
      })
    }

    const telegramUser = result.user
    const telegramId = String(telegramUser.id)

    const telegramNickname = normalizeTelegramUsername(
      telegramUser.username,
      telegramId
    )

    const existingUser = await getUserByTelegramId(telegramId)

    if (existingUser) {
      const { data: updatedUser, error } = await supabase
        .from('users')
        .update({
          telegram_id: telegramId,

          username: telegramNickname,
          app_nickname: telegramNickname,
          telegram_username: telegramNickname,

          first_name: telegramUser.first_name || existingUser.first_name || '',
          last_name: telegramUser.last_name || existingUser.last_name || '',

          display_name:
            telegramUser.first_name ||
            telegramNickname ||
            existingUser.display_name ||
            `Telegram ${telegramId}`,

          telegram_avatar_url:
            telegramUser.photo_url || existingUser.telegram_avatar_url || '',

          auth_provider: existingUser.email ? 'mixed' : 'telegram',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingUser.id)
        .select()
        .single()

      if (error) {
        return res.status(500).json({
          success: false,
          error: error.message,
        })
      }

      const token = createToken(updatedUser)

      return res.json({
        success: true,
        token,
        user: publicUser(updatedUser),
      })
    }

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        telegram_id: telegramId,

        username: telegramNickname,
        app_nickname: telegramNickname,
        telegram_username: telegramNickname,

        first_name: telegramUser.first_name || '',
        last_name: telegramUser.last_name || '',

        display_name:
          telegramUser.first_name ||
          telegramNickname ||
          `Telegram ${telegramId}`,

        telegram_avatar_url: telegramUser.photo_url || '',
        auth_provider: 'telegram',
      })
      .select()
      .single()

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      })
    }

    const token = createToken(user)

    res.json({
      success: true,
      token,
      user: publicUser(user),
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    })
  }
})

router.post(
  '/link-email/request',
  authMiddleware,
  validateBody(linkEmailRequestSchema),
  async (req, res) => {
    try {
      const result = await requestLinkEmail({
        currentUser: req.user,
        email: req.body.email,
      })

      if (!result.success) {
        return res.status(result.status || 400).json({
          success: false,
          error: result.error,
        })
      }

      res.json({
        success: true,
        requiresCode: true,
        linkEmailSessionId: result.linkEmailSessionId,
        nextCooldownSeconds: result.nextCooldownSeconds,
        message: 'OTP_CODE_SENT',
      })
    } catch (error) {
      return handleOtpError(res, error)
    }
  }
)

router.post(
  '/link-email/confirm',
  authMiddleware,
  validateBody(linkEmailConfirmSchema),
  async (req, res) => {
    try {
      const { linkEmailSessionId, code } = req.body

      const result = await verifyCodeSession({
        sessionId: linkEmailSessionId,
        purposes: ['link_email'],
        code,
      })

      if (!result.success) {
        return res.status(result.status).json({
          success: false,
          error: result.error,
        })
      }

      if (result.user.id !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
        })
      }

      const normalizedEmail = normalizeEmail(result.payload.email)

      if (!normalizedEmail) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_LINK_EMAIL_SESSION',
        })
      }

      const emailCheck = await ensureEmailIsFree(normalizedEmail, result.user.id)

      if (!emailCheck.success) {
        return res.status(409).json({
          success: false,
          error: emailCheck.error,
        })
      }

      const { data: updatedUser, error } = await supabase
        .from('users')
        .update({
          email: normalizedEmail,
          email_verified: true,
          auth_provider: result.user.telegram_id ? 'mixed' : 'web_email',
        })
        .eq('id', result.user.id)
        .select()
        .single()

      if (error) {
        return res.status(500).json({
          success: false,
          error: error.message,
        })
      }

      const token = createToken(updatedUser)

      res.json({
        success: true,
        token,
        user: publicUser(updatedUser),
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      })
    }
  }
)

router.post(
  '/link-email',
  authMiddleware,
  validateBody(linkEmailRequestSchema),
  async (req, res) => {
    try {
      const result = await requestLinkEmail({
        currentUser: req.user,
        email: req.body.email,
      })

      if (!result.success) {
        return res.status(result.status || 400).json({
          success: false,
          error: result.error,
        })
      }

      res.json({
        success: true,
        requiresCode: true,
        linkEmailSessionId: result.linkEmailSessionId,
        nextCooldownSeconds: result.nextCooldownSeconds,
        message: 'OTP_CODE_SENT',
      })
    } catch (error) {
      return handleOtpError(res, error)
    }
  }
)

router.post(
  '/change-email/request',
  authMiddleware,
  validateBody(changeEmailRequestSchema),
  async (req, res) => {
    try {
      const currentUser = await getFreshUser(req.user.id)

      if (!currentUser) {
        return res.status(404).json({
          success: false,
          error: 'USER_NOT_FOUND',
        })
      }

      if (!currentUser.email || !currentUser.email_verified) {
        return res.status(400).json({
          success: false,
          error: 'EMAIL_NOT_LINKED',
        })
      }

      if (!currentUser.password_hash) {
        return res.status(400).json({
          success: false,
          error: 'PASSWORD_NOT_SET',
        })
      }

      const isPasswordValid = await bcrypt.compare(
        req.body.password,
        currentUser.password_hash
      )

      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'INVALID_PASSWORD',
        })
      }

      const normalizedNewEmail = normalizeEmail(req.body.newEmail)

      if (normalizedNewEmail === normalizeEmail(currentUser.email)) {
        return res.status(400).json({
          success: false,
          error: 'SAME_EMAIL',
        })
      }

      const emailCheck = await ensureEmailIsFree(
        normalizedNewEmail,
        currentUser.id
      )

      if (!emailCheck.success) {
        return res.status(409).json({
          success: false,
          error: emailCheck.error,
        })
      }

      const result = await createEmailCode({
        user: currentUser,
        purpose: 'change_email',
        toEmail: normalizedNewEmail,
        payload: {
          newEmail: normalizedNewEmail,
        },
      })

      res.json({
        success: true,
        requiresCode: true,
        changeEmailSessionId: result.sessionId,
        nextCooldownSeconds: result.nextCooldownSeconds,
        message: 'OTP_CODE_SENT',
      })
    } catch (error) {
      return handleOtpError(res, error)
    }
  }
)

router.post(
  '/change-email/confirm',
  authMiddleware,
  validateBody(changeEmailConfirmSchema),
  async (req, res) => {
    try {
      const { changeEmailSessionId, code } = req.body

      const result = await verifyCodeSession({
        sessionId: changeEmailSessionId,
        purposes: ['change_email'],
        code,
      })

      if (!result.success) {
        return res.status(result.status).json({
          success: false,
          error: result.error,
        })
      }

      if (result.user.id !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
        })
      }

      const normalizedNewEmail = normalizeEmail(result.payload.newEmail)

      if (!normalizedNewEmail) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_CHANGE_EMAIL_SESSION',
        })
      }

      const emailCheck = await ensureEmailIsFree(normalizedNewEmail, result.user.id)

      if (!emailCheck.success) {
        return res.status(409).json({
          success: false,
          error: emailCheck.error,
        })
      }

      const { data: updatedUser, error } = await supabase
        .from('users')
        .update({
          email: normalizedNewEmail,
          email_verified: true,
          auth_provider: result.user.telegram_id ? 'mixed' : 'web_email',
        })
        .eq('id', result.user.id)
        .select()
        .single()

      if (error) {
        return res.status(500).json({
          success: false,
          error: error.message,
        })
      }

      const token = createToken(updatedUser)

      res.json({
        success: true,
        token,
        user: publicUser(updatedUser),
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      })
    }
  }
)

router.post(
  '/change-password/request',
  authMiddleware,
  validateBody(changePasswordRequestSchema),
  async (req, res) => {
    try {
      const currentUser = await getFreshUser(req.user.id)

      if (!currentUser) {
        return res.status(404).json({
          success: false,
          error: 'USER_NOT_FOUND',
        })
      }

      if (!currentUser.email || !currentUser.email_verified) {
        return res.status(400).json({
          success: false,
          error: 'PASSWORD_CHANGE_REQUIRES_EMAIL',
        })
      }

      const result = await createEmailCode({
        user: currentUser,
        purpose: 'change_password',
        toEmail: currentUser.email,
        payload: {},
      })

      res.json({
        success: true,
        requiresCode: true,
        changePasswordSessionId: result.sessionId,
        nextCooldownSeconds: result.nextCooldownSeconds,
        message: 'OTP_CODE_SENT',
      })
    } catch (error) {
      return handleOtpError(res, error)
    }
  }
)

router.post(
  '/change-password/confirm',
  authMiddleware,
  validateBody(changePasswordConfirmSchema),
  async (req, res) => {
    try {
      const { changePasswordSessionId, code, newPassword } = req.body

      const result = await verifyCodeSession({
        sessionId: changePasswordSessionId,
        purposes: ['change_password'],
        code,
      })

      if (!result.success) {
        return res.status(result.status).json({
          success: false,
          error: result.error,
        })
      }

      if (result.user.id !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
        })
      }

      const currentUser = await getFreshUser(result.user.id)

      if (!currentUser) {
        return res.status(404).json({
          success: false,
          error: 'USER_NOT_FOUND',
        })
      }

      if (currentUser.password_hash) {
        const samePassword = await bcrypt.compare(
          newPassword,
          currentUser.password_hash
        )

        if (samePassword) {
          return res.status(400).json({
            success: false,
            error: 'NEW_PASSWORD_SAME_AS_OLD',
          })
        }
      }

      const newPasswordHash = await bcrypt.hash(newPassword, 12)

      const { data: updatedUser, error } = await supabase
        .from('users')
        .update({
          password_hash: newPasswordHash,
        })
        .eq('id', currentUser.id)
        .select()
        .single()

      if (error) {
        return res.status(500).json({
          success: false,
          error: error.message,
        })
      }

      const token = createToken(updatedUser)

      res.json({
        success: true,
        token,
        user: publicUser(updatedUser),
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      })
    }
  }
)

router.get('/me', authMiddleware, async (req, res) => {
  res.json({
    success: true,
    user: publicUser(req.user),
  })
})

module.exports = router