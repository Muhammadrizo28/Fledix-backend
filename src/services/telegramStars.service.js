const { supabase } = require('./supabaseClient')

function getBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN_REQUIRED')
  }

  return token
}

async function callTelegram(method, body) {
  const token = getBotToken()

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )

  const data = await response.json().catch(() => null)

  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || `TELEGRAM_${method}_FAILED`)
    error.status = response.status
    error.telegramResponse = data
    throw error
  }

  return data.result
}

async function createStarsInvoiceLink({ userId, planId }) {
  const { data: plan, error: planError } = await supabase
    .from('premium_plans')
    .select(
      `
      id,
      plan_key,
      label_key,
      duration_days,
      bonus_axion,
      premium_plan_prices!inner (
        payment_type,
        amount,
        is_active
      )
      `
    )
    .eq('plan_key', planId)
    .eq('is_active', true)
    .eq('premium_plan_prices.payment_type', 'stars')
    .eq('premium_plan_prices.is_active', true)
    .single()

  if (planError || !plan) {
    return {
      success: false,
      error: 'PLAN_OR_PRICE_NOT_FOUND',
    }
  }

  const starsPrice = Number(plan.premium_plan_prices?.[0]?.amount || 0)

  if (starsPrice <= 0) {
    return {
      success: false,
      error: 'INVALID_STARS_PRICE',
    }
  }

  const payload = `premium_stars:${userId}:${plan.plan_key}:${Date.now()}`

  const { error: insertError } = await supabase
    .from('telegram_star_payments')
    .insert({
      user_id: userId,
      plan_key: plan.plan_key,
      payload,
      amount: starsPrice,
      status: 'pending',
    })

  if (insertError) {
    return {
      success: false,
      error: insertError.message || 'STAR_PAYMENT_CREATE_FAILED',
    }
  }

  const invoiceLink = await callTelegram('createInvoiceLink', {
    title: `Fledix Pro - ${plan.plan_key}`,
    description: `Fledix Pro subscription for ${plan.duration_days} days`,
    payload,
    currency: 'XTR',
    prices: [
      {
        label: 'Fledix Pro',
        amount: starsPrice,
      },
    ],
  })

  return {
    success: true,
    invoiceLink,
    payload,
    amount: starsPrice,
    plan: {
      id: plan.plan_key,
      durationDays: Number(plan.duration_days || 0),
      bonusAxion: Number(plan.bonus_axion || 0),
    },
  }
}

async function answerPreCheckoutQuery({ preCheckoutQueryId, ok, errorMessage }) {
  return callTelegram('answerPreCheckoutQuery', {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  })
}

async function activateStarsPayment({ payload, telegramPaymentChargeId, providerPaymentChargeId }) {
  const { data, error } = await supabase.rpc(
    'activate_premium_after_stars_payment',
    {
      p_payload: payload,
      p_telegram_payment_charge_id: telegramPaymentChargeId || '',
      p_provider_payment_charge_id: providerPaymentChargeId || '',
    }
  )

  if (error) {
    return {
      success: false,
      error: error.message || 'STAR_PAYMENT_ACTIVATION_FAILED',
    }
  }

  if (!data?.success) {
    return {
      success: false,
      error: data?.error || 'STAR_PAYMENT_ACTIVATION_FAILED',
    }
  }

  return data
}

module.exports = {
  createStarsInvoiceLink,
  answerPreCheckoutQuery,
  activateStarsPayment,
}