const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses')

const sesClient = new SESClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
})

const OTP_PURPOSE_TEXT = {
  login: {
    subject: 'Your Fledix login code',
    title: 'Fledix login code',
    description: 'Use this one-time code to confirm your login.',
    text: 'login',
  },

  registration: {
    subject: 'Your Fledix registration code',
    title: 'Fledix registration code',
    description: 'Use this one-time code to finish creating your account.',
    text: 'registration',
  },

  link_email: {
    subject: 'Your Fledix email connection code',
    title: 'Fledix email connection code',
    description: 'Use this one-time code to connect this email to your account.',
    text: 'email connection',
  },

  change_email: {
    subject: 'Your Fledix email change code',
    title: 'Fledix email change code',
    description: 'Use this one-time code to confirm your new email address.',
    text: 'email change',
  },

  change_password: {
    subject: 'Your Fledix password change code',
    title: 'Fledix password change code',
    description: 'Use this one-time code to change your account password.',
    text: 'password change',
  },
}

function getPurposeConfig(purpose) {
  return OTP_PURPOSE_TEXT[purpose] || OTP_PURPOSE_TEXT.login
}

async function sendEmail({ to, subject, text, html }) {
  if (!to) {
    throw new Error('Email recipient is required')
  }

  if (!process.env.SES_FROM_EMAIL) {
    throw new Error('SES_FROM_EMAIL is missing')
  }

  const command = new SendEmailCommand({
    Source: process.env.SES_FROM_EMAIL,
    Destination: {
      ToAddresses: [to],
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8',
      },
      Body: {
        Text: {
          Data: text,
          Charset: 'UTF-8',
        },
        Html: {
          Data: html,
          Charset: 'UTF-8',
        },
      },
    },
  })

  return sesClient.send(command)
}

async function sendOtpEmail({ to, code, purpose = 'login' }) {
  const config = getPurposeConfig(purpose)

  return sendEmail({
    to,
    subject: config.subject,
    text: `Your Fledix verification code for ${config.text} is: ${code}. This code expires in 10 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; background:#061223; padding:24px;">
        <div style="max-width:480px; margin:0 auto; background:#101d31; border-radius:16px; padding:24px; color:white;">
          <h2 style="margin:0 0 12px; font-size:22px;">${config.title}</h2>

          <p style="color:#a9b2c3; font-size:14px; line-height:1.5;">
            ${config.description}
          </p>

          <div style="margin:24px 0; padding:18px; background:#0e2950; border-radius:12px; text-align:center;">
            <span style="font-size:32px; letter-spacing:6px; font-weight:800; color:#26c6da;">
              ${code}
            </span>
          </div>

          <p style="color:#a9b2c3; font-size:13px;">
            This code expires in 10 minutes. If you did not request this, ignore this email.
          </p>
        </div>
      </div>
    `,
  })
}

// чтобы старый код не сломался
async function sendLoginOtpEmail({ to, code }) {
  return sendOtpEmail({
    to,
    code,
    purpose: 'login',
  })
}

module.exports = {
  sendEmail,
  sendOtpEmail,
  sendLoginOtpEmail,
}