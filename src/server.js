const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
require('dotenv').config()

const authRoutes = require('./routes/auth.routes')
const usersRoutes = require('./routes/users.routes')
const tasksRoutes = require('./routes/tasks.routes')
const challengesRoutes = require('./routes/challenges.routes')
const friendsRoutes = require('./routes/friends.routes')
const challengeProgressRoutes = require('./routes/challengeProgress.routes')
const streakRoutes = require('./routes/streak.routes')
const subscriptionRoutes = require('./routes/subscription.routes')
const telegramRoutes = require('./routes/telegram.routes')
const referralsRoutes = require('./routes/referrals.routes')
const telegramUserRoutes = require('./routes/telegramUser.routes')
const notificationsRoutes = require('./routes/notifications.routes')
const focusRoutes = require('./routes/focus.routes')
const premiumRoutes = require('./routes/premium.routes')
const userSettingsRoutes = require('./routes/userSettings.routes')

const {
  initNotificationScheduler,
} = require('./services/notificationScheduler.service')

const { errorHandler } = require('./middleware/errorHandler')

const app = express()
const PORT = process.env.PORT || 3000

app.set('trust proxy', 1)

const corsOptions = {
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://192.168.0.23:5173',

    'https://fledix.app',
    'https://www.fledix.app',
  ],
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}

app.use(helmet())
app.use(cors(corsOptions))
app.options(/.*/, cors(corsOptions))

app.use(express.json({ limit: '1mb' }))

app.use('/api/telegram', telegramRoutes)
app.use('/api/referrals', referralsRoutes)
app.use('/api/telegram-user', telegramUserRoutes)
app.use('/api/focus', focusRoutes)
app.use('/api/user-settings', userSettingsRoutes)

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
)

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Fledix backend is running',
    time: new Date().toISOString(),
  })
})

app.use('/api/auth', authRoutes)
app.use('/api/users', usersRoutes)
app.use('/api/tasks', tasksRoutes)
app.use('/api/challenges', challengesRoutes)
app.use('/api/friends', friendsRoutes)
app.use('/api/challenge-progress', challengeProgressRoutes)
app.use('/api/streak', streakRoutes)
app.use('/api/subscription', subscriptionRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/premium', premiumRoutes)

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  })
})

app.use(errorHandler)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`)

  initNotificationScheduler()
  console.log('Notification scheduler started')
})