import { createClient } from '@supabase/supabase-js'

/**
 * Browser client. Only the PUBLISHABLE (anon) key may be used here —
 * every query is constrained by RLS. Service/secret keys must never be
 * exposed through VITE_* variables.
 */
const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const isConfigured = Boolean(url && publishableKey && !publishableKey.startsWith('YOUR_'))

if (isConfigured && /^(sb_secret_|service_role)/.test(publishableKey)) {
  throw new Error('A secret/service key was supplied to the browser. Use the publishable key only.')
}

export const supabase = isConfigured
  ? createClient(url, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null
