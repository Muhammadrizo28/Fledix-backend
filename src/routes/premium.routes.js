const express = require('express')

const { supabase } = require('../services/supabaseClient')

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
    return res.status(500).json({
      success: false,
      error: error.message || 'PREMIUM_PRICES_LOAD_FAILED',
    })
  }
})

module.exports = router