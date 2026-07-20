import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

// Uses the default `public` schema — Supabase's exposed-schema config for a
// dedicated `havelock` schema got stuck out of sync with the running
// PostgREST instance (confirmed via support ticket SU-426244), so tables
// live in `public` with a `havelock_` prefix instead of a separate schema.
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
)
