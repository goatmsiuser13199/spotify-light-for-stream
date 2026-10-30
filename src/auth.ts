/** Redirect URI à coller dans le Dashboard Spotify (identique pour tout le monde). */
export const REDIRECT_URI = 'http://127.0.0.1:5173/callback'

const PREF_CLIENT_ID = 'spotify_client_id'
const LS_CLIENT_ID = 'sl_client_id'

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
].join(' ')

const KEYS = {
  verifier: 'sl_code_verifier',
  access: 'sl_access_token',
  refresh: 'sl_refresh_token',
  expires: 'sl_expires_at',
} as const

let clientIdCache: string | null = null

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

function normalizeClientId(raw: string): string {
  return raw.trim()
}

function isValidClientId(id: string): boolean {
  return Boolean(id && id !== 'ton_client_id_ici' && id.length >= 16)
}

/** Charge le Client ID enregistré localement (disque + localStorage). */
export async function loadClientId(): Promise<string> {
  if (clientIdCache && isValidClientId(clientIdCache)) return clientIdCache

  let id = normalizeClientId(localStorage.getItem(LS_CLIENT_ID) ?? '')

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const stored = await invoke<string | null>('get_pref', { key: PREF_CLIENT_ID })
      if (stored && isValidClientId(normalizeClientId(stored))) {
        id = normalizeClientId(stored)
      }
    } catch {
      /* ignore */
    }
  }

  clientIdCache = isValidClientId(id) ? id : ''
  if (clientIdCache) localStorage.setItem(LS_CLIENT_ID, clientIdCache)
  return clientIdCache
}

export function getClientId(): string {
  if (clientIdCache && isValidClientId(clientIdCache)) return clientIdCache
  const ls = normalizeClientId(localStorage.getItem(LS_CLIENT_ID) ?? '')
  if (isValidClientId(ls)) {
    clientIdCache = ls
    return ls
  }
  return ''
}

export function hasClientId(): boolean {
  return isValidClientId(getClientId())
}

/** Enregistre le Client ID (fichier + localStorage) pour les prochains lancements. */
export async function saveClientId(raw: string): Promise<void> {
  const id = normalizeClientId(raw)
  if (!isValidClientId(id)) {
    throw new Error('Client ID invalide')
  }
  clientIdCache = id
  localStorage.setItem(LS_CLIENT_ID, id)
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_pref', { key: PREF_CLIENT_ID, value: id })
  }
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const values = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(values, (v) => chars[v % chars.length]).join('')
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const data = new TextEncoder().encode(plain)
  return crypto.subtle.digest('SHA-256', data)
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let str = ''
  bytes.forEach((b) => {
    str += String.fromCharCode(b)
  })
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function getAccessToken(): string | null {
  const token = localStorage.getItem(KEYS.access)
  const expires = Number(localStorage.getItem(KEYS.expires) ?? 0)
  if (!token || Date.now() >= expires - 60_000) return null
  return token
}

function storeTokens(data: {
  access_token: string
  refresh_token?: string
  expires_in: number
}): void {
  localStorage.setItem(KEYS.access, data.access_token)
  localStorage.setItem(KEYS.expires, String(Date.now() + data.expires_in * 1000))
  if (data.refresh_token) {
    localStorage.setItem(KEYS.refresh, data.refresh_token)
  }
}

async function exchangeCode(code: string): Promise<void> {
  const verifier = localStorage.getItem(KEYS.verifier)
  if (!verifier) throw new Error('Code verifier manquant')
  const clientId = getClientId()
  if (!clientId) throw new Error('Client ID manquant')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  })

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Échange token échoué: ${text}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  storeTokens(data)
  localStorage.removeItem(KEYS.verifier)
}

async function buildAuthUrl(): Promise<string> {
  const clientId = getClientId()
  if (!clientId) {
    throw new Error('Entre ton Client ID Spotify avant de te connecter')
  }

  const verifier = randomString(64)
  const challenge = base64UrlEncode(await sha256(verifier))
  localStorage.setItem(KEYS.verifier, verifier)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    redirect_uri: REDIRECT_URI,
    show_dialog: 'true',
  })

  return `https://accounts.spotify.com/authorize?${params}`
}

async function loginDesktop(authUrl: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false
    const unsubs: Array<() => void> = []

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      unsubs.forEach((u) => u())
      fn()
    }

    void (async () => {
      try {
        unsubs.push(
          await listen<string>('spotify-oauth-code', (ev) => {
            finish(() => resolve(ev.payload))
          }),
        )
        unsubs.push(
          await listen<string>('spotify-oauth-error', (ev) => {
            finish(() => reject(new Error(ev.payload)))
          }),
        )
        await invoke('start_oauth_listener')
        await invoke('open_url', { url: authUrl })
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))))
      }
    })()
  })

  await exchangeCode(code)
}

export async function login(): Promise<void> {
  await loadClientId()
  const authUrl = await buildAuthUrl()

  if (isTauri()) {
    await loginDesktop(authUrl)
    window.location.reload()
    return
  }

  window.location.href = authUrl
}

export async function handleCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const error = params.get('error')

  if (error) throw new Error(`Auth refusée: ${error}`)
  if (!code) return false

  await loadClientId()
  await exchangeCode(code)
  window.history.replaceState({}, '', '/')
  return true
}

export async function refreshAccessToken(): Promise<string | null> {
  const refresh = localStorage.getItem(KEYS.refresh)
  const clientId = getClientId()
  if (!refresh || !clientId) return null

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId,
  })

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    logout()
    return null
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  storeTokens(data)
  return data.access_token
}

export async function ensureToken(): Promise<string | null> {
  await loadClientId()
  const current = getAccessToken()
  if (current) return current
  return refreshAccessToken()
}

export function logout(): void {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k))
}

/** Efface la session et relance le login (nouveaux scopes / bon compte). */
export async function forceRelogin(): Promise<void> {
  logout()
  await login()
}
