const express = require('express')

const { supabase } = require('../services/supabaseClient')
const { authMiddleware } = require('../middleware/auth.middleware')
const {
  createStarsInvoiceLink,
} = require('../services/telegramStars.service')

const router = express.Router()

router.get('/prices', async (req, res) => {
  try {
    const { data: plans, error: plansError } = await supabase
      .from('premium_plans')
      .select(
        `
        id,
        plan_key,
        label_key,
        duration_days,
        bonus_axion,
        sort_order
        `
      )
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    if (plansError) {
      return res.status(500).json({
        success: false,
        error: plansError.message || 'PREMIUM_PLANS_LOAD_FAILED',
      })
    }

    const planIds = plans.map((plan) => plan.id)

    if (planIds.length === 0) {
      return res.json({
        success: true,
        plans: [],
      })
    }

    const { data: prices, error: pricesError } = await supabase
      .from('premium_plan_prices')
      .select(
        `
        plan_id,
        payment_type,
        amount
        `
      )
      .in('plan_id', planIds)
      .eq('is_active', true)

    if (pricesError) {
      return res.status(500).json({
        success: false,
        error: pricesError.message || 'PREMIUM_PRICES_LOAD_FAILED',
      })
    }

    const pricesByPlanId = new Map()

    for (const price of prices || []) {
      const current = pricesByPlanId.get(price.plan_id) || {}
      current[price.payment_type] = Number(price.amount || 0)
      pricesByPlanId.set(price.plan_id, current)
    }

    const serializedPlans = plans.map((plan) => {
      const planPrices = pricesByPlanId.get(plan.id) || {}

      return {
        id: plan.plan_key,
        labelKey: plan.label_key,
        durationDays: Number(plan.duration_days || 0),
        bonusAxion: Number(plan.bonus_axion || 0),

        stars: Number(planPrices.stars || 0),
        axion: Number(planPrices.axion || 0),
        friends: Number(planPrices.friends || 0),
      }
    })

    return res.json({
      success: true,
      plans: serializedPlans,
    })
  } catch (error) {
    console.error('PREMIUM_PRICES_ERROR:', error)

    return res.status(500).json({
      success: false,
      error: error.message || 'PREMIUM_PRICES_LOAD_FAILED',
    })
  }
})

router.post('/purchase', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const body = req.body || {}

    const planId = String(body.planId || '').trim()
    const methodId = String(body.methodId || '').trim()

    if (!planId) {
      return res.status(400).json({
        success: false,
        error: 'PLAN_REQUIRED',
      })
    }

    if (!methodId) {
      return res.status(400).json({
        success: false,
        error: 'PAYMENT_METHOD_REQUIRED',
      })
    }

    if (methodId === 'stars') {
      return res.status(400).json({
        success: false,
        error: 'STARS_PAYMENT_NOT_READY',
      })
    }

    if (methodId !== 'axion' && methodId !== 'friends') {
      return res.status(400).json({
        success: false,
        error: 'PAYMENT_METHOD_NOT_SUPPORTED',
      })
    }

    const { data, error } = await supabase.rpc(
      'purchase_premium_with_balance',
      {
        p_user_id: userId,
        p_plan_key: planId,
        p_payment_type: methodId,
      }
    )

    if (error) {
      console.error('PREMIUM_PURCHASE_RPC_ERROR:', error)

      return res.status(500).json({
        success: false,
        error: error.message || 'PREMIUM_PURCHASE_RPC_FAILED',
      })
    }

    console.log('PREMIUM_PURCHASE_RPC_RESULT:', data)

    if (!data || data.success !== true) {
      return res.status(400).json({
        success: false,
        error: data?.error || 'PREMIUM_PURCHASE_FAILED',
        required: data?.required || null,
        current: data?.current || null,
      })
    }

    return res.json({
      success: true,
      purchase: data.purchase || null,
      subscription: data.subscription || null,
      balances: data.balances || null,
      bonusClaim: data.bonusClaim || null,
    })
  } catch (error) {
    console.error('PREMIUM_PURCHASE_ROUTE_ERROR:', {
      message: error.message,
      stack: error.stack,
    })

    return res.status(500).json({
      success: false,
      error: error.message || 'PREMIUM_PURCHASE_ROUTE_FAILED',
    })
  }
})

router.get('/bonus-claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const { data: claim, error } = await supabase
      .from('premium_bonus_claims')
      .select('id, plan_key, bonus_axion, available_at, status')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .lte('available_at', new Date().toISOString())
      .order('available_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error('BONUS_CLAIM_LOAD_ERROR:', error)

      return res.status(500).json({
        success: false,
        error: error.message || 'BONUS_CLAIM_LOAD_FAILED',
      })
    }

    return res.json({
      success: true,
      claim: claim
        ? {
            id: claim.id,
            planKey: claim.plan_key,
            bonusAxion: Number(claim.bonus_axion || 0),
            availableAt: claim.available_at,
            status: claim.status,
          }
        : null,
    })
  } catch (error) {
    console.error('BONUS_CLAIM_ROUTE_ERROR:', error)

    return res.status(500).json({
      success: false,
      error: error.message || 'BONUS_CLAIM_LOAD_FAILED',
    })
  }
})

router.post('/bonus-claim/:claimId/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { claimId } = req.params

    const { data, error } = await supabase.rpc('claim_premium_bonus', {
      p_user_id: userId,
      p_claim_id: claimId,
    })

    if (error) {
      console.error('BONUS_CLAIM_RPC_ERROR:', error)

      return res.status(500).json({
        success: false,
        error: error.message || 'BONUS_CLAIM_RPC_FAILED',
      })
    }

    if (!data || data.success !== true) {
      return res.status(400).json({
        success: false,
        error: data?.error || 'BONUS_CLAIM_FAILED',
        availableAt: data?.availableAt || null,
      })
    }

    return res.json({
      success: true,
      bonus: data.bonus || null,
      balances: data.balances || null,
    })
  } catch (error) {
    console.error('BONUS_CLAIM_ROUTE_ERROR:', {
      message: error.message,
      stack: error.stack,
    })

    return res.status(500).json({
      success: false,
      error: error.message || 'BONUS_CLAIM_ROUTE_FAILED',
    })
  }
})


router.post('/stars/invoice', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { planId } = req.body || {}

    if (!planId) {
      return res.status(400).json({
        success: false,
        error: 'PLAN_REQUIRED',
      })
    }

    const result = await createStarsInvoiceLink({
      userId,
      planId: String(planId).trim(),
    })

    if (!result.success) {
      return res.status(400).json(result)
    }

    return res.json(result)
  } catch (error) {
    console.error('STARS_INVOICE_CREATE_ERROR:', error)

    return res.status(500).json({
      success: false,
      error: error.message || 'STARS_INVOICE_CREATE_FAILED',
    })
  }
})

module.exports = router