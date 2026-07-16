import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, supabaseConfigured } from './lib/supabase'
import { Login } from './components/Login'
import { HavelockReportPage } from './components/HavelockReportPage'
import { readLaunchToken, stripFragment } from './lib/launchToken'
import { exchangeSpineToken } from './lib/spineSso'
import './App.css'

function SetupNeeded() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Havelock Orders</h1>
        <p className="subtitle">
          This site isn't connected to Supabase yet. Add{' '}
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> as
          environment variables (see the README) and redeploy.
        </p>
      </div>
    </div>
  )
}

function SigningIn() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Havelock Orders</h1>
        <p className="subtitle">Signing you in via SPINE…</p>
      </div>
    </div>
  )
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  // True only while we're exchanging a SPINE launch token for a session.
  const [ssoBusy, setSsoBusy] = useState(false)

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false)
      return
    }

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })

    // Consume a SPINE launch token (if any) BEFORE deciding what to render, so we
    // never flash the password login for someone who arrived through the tile.
    async function boot() {
      const token = readLaunchToken()
      if (token) {
        setSsoBusy(true)
        const error = await exchangeSpineToken(token)
        stripFragment()
        if (error) {
          // Token expired / invalid — fall back to the shared-password login below.
          console.warn('SPINE SSO:', error)
        }
        setSsoBusy(false)
      }
      // On a plain reload there's no token; getSession restores the persisted
      // Supabase session so people stay signed in.
      const { data } = await supabase.auth.getSession()
      setSession(data.session)
      setLoading(false)
    }

    boot()
    return () => listener.subscription.unsubscribe()
  }, [])

  if (!supabaseConfigured) return <SetupNeeded />
  if (loading || ssoBusy) return session ? <HavelockReportPage /> : <SigningIn />

  return session ? <HavelockReportPage /> : <Login />
}

export default App
