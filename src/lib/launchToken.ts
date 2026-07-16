// SPINE launch token helpers.
//
// When a user clicks the Havelock Orders tile in SPINE, SPINE opens this app at
// `https://<site>.netlify.app/#srv_token=<payload>.<sig>`. The token rides
// in the URL *hash* and is single-use / short-lived (~90s). We read it on first
// paint, hand it to the `havelock-sso-verify` edge function, then strip it from the URL.

const TOKEN_KEY = 'srv_token'

/** Read the `#srv_token=…` value from the current URL hash, if present. */
export function readLaunchToken(): string | null {
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const token = params.get(TOKEN_KEY)
  return token && token.length > 0 ? token : null
}

/** Remove the launch token from the URL so it never lingers in history/logs. */
export function stripFragment(): void {
  const url = window.location.pathname + window.location.search
  window.history.replaceState(null, '', url)
}
