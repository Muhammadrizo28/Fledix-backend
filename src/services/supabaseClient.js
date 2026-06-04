const { createClient } = require('@supabase/supabase-js')

const supabaseUrl = process.env.SUPABASE_URL

const supabaseKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.log('SUPABASE_URL exists:', Boolean(supabaseUrl))
  console.log('SUPABASE_SECRET_KEY exists:', Boolean(process.env.SUPABASE_SECRET_KEY))
  console.log(
    'SUPABASE_SERVICE_ROLE_KEY exists:',
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  )

  throw new Error('Missing Supabase environment variables')
}

const supabase = createClient(supabaseUrl, supabaseKey)

module.exports = { supabase }