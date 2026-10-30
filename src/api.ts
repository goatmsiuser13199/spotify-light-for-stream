import { ensureToken, logout } from './auth'

const API = 'https://api.spotify.com/v1'

export type LikedTrack = {
  uri: string
  name: string
  artists: string
  album: string
  artUrl: string
  durationMs: number
  addedAt: string
}

export type SpotifyDevice = {
  id: string
  name: string
  type: string
  is_active: boolean
  volume_percent: number | null
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await ensureToken()
  if (!token) throw new Error('Non authentifié')
  return { Authorization: `Bearer ${token}` }
}

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  const headers = await authHeaders()
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers ?? {}),
    },
  })

  if (res.status === 401) {
    logout()
    window.location.reload()
    return null
  }

  // Spotify renvoie souvent 204 / 200 vide (play, pause, repeat, transfer…)
  if (res.status === 204 || res.status === 202) return null

  const text = await res.text()

  if (!res.ok) {
    if (res.status === 403 && /insufficient|scope/i.test(text)) {
      throw new Error(
        'Droit manquant pour les titres likés. Déconnecte-toi puis reconnecte-toi.',
      )
    }
    let detail = text || `HTTP ${res.status}`
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      if (parsed.error?.message) detail = parsed.error.message
    } catch {
      /* raw text */
    }
    throw new Error(detail)
  }

  if (!text.trim()) return null

  try {
    return JSON.parse(text) as T
  } catch {
    // corps non-JSON inattendu sur un succès → on ignore
    return null
  }
}

export async function getMe(): Promise<{
  id: string
  display_name: string | null
  email?: string
  country?: string
}> {
  const data = await request<{
    id: string
    display_name: string | null
    email?: string
    country?: string
  }>('/me')
  if (!data) throw new Error('Profil Spotify introuvable')
  return data
}

let cachedMarket: string | null | undefined

/** Pays ISO du compte (cache session) pour /search — from_token est rejeté par Spotify. */
export async function getSearchMarket(): Promise<string | undefined> {
  if (cachedMarket !== undefined) return cachedMarket ?? undefined
  try {
    const me = await getMe()
    cachedMarket = me.country?.trim() || null
  } catch {
    cachedMarket = null
  }
  return cachedMarket ?? undefined
}

export async function transferPlayback(deviceId: string, play = false): Promise<void> {
  await request('/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play }),
  })
}

export async function getDevices(): Promise<SpotifyDevice[]> {
  const data = await request<{ devices: SpotifyDevice[] }>('/me/player/devices')
  return data?.devices.filter((d) => d.id) ?? []
}

export type LikedFetchResult = {
  tracks: LikedTrack[]
  total: number
}

export async function fetchLikedTracks(max = 500): Promise<LikedFetchResult> {
  const tracks: LikedTrack[] = []
  let offset = 0
  const limit = 50
  let total = 0

  while (tracks.length < max) {
    // sans market= : évite de filtrer des titres "indisponibles" à tort
    const data = await request<{
      items: Array<{
        added_at: string
        track: {
          uri: string
          name: string
          duration_ms: number
          artists: Array<{ name: string }>
          album: { name: string; images: Array<{ url: string }> }
        } | null
      }>
      next: string | null
      total: number
    }>(`/me/tracks?limit=${limit}&offset=${offset}`)

    if (!data) break
    total = data.total

    if (!data.items.length) break

    for (const item of data.items) {
      const t = item.track
      if (!t?.uri) continue
      tracks.push({
        uri: t.uri,
        name: t.name,
        artists: t.artists.map((a) => a.name).join(', '),
        album: t.album.name,
        artUrl: t.album.images[2]?.url ?? t.album.images[0]?.url ?? '',
        durationMs: t.duration_ms,
        addedAt: item.added_at,
      })
    }

    if (!data.next) break
    offset += limit
  }

  if (total > 0 && tracks.length === 0) {
    throw new Error(
      `Spotify indique ${total} titres likés mais aucun n’est lisible ici. Réessaie ou reconnecte-toi.`,
    )
  }

  return { tracks, total }
}

type SearchTrackItem = {
  uri: string
  name: string
  duration_ms: number
  artists: Array<{ name: string }>
  album: { name: string; images: Array<{ url: string }> }
} | null

function mapSearchItem(t: NonNullable<SearchTrackItem>): LikedTrack {
  return {
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => a.name).join(', '),
    album: t.album.name,
    artUrl: t.album.images[2]?.url ?? t.album.images[0]?.url ?? '',
    durationMs: t.duration_ms,
    addedAt: '',
  }
}

/**
 * Dev Mode Spotify : limit max = 10 sur /search (février 2026).
 * Au-delà → 400 "Invalid limit". On pagine par 10.
 */
export async function searchTracks(query: string, limit = 30): Promise<LikedTrack[]> {
  if (!query.trim()) return []
  const target = Math.min(50, Math.max(1, Math.floor(limit) || 30))
  const pageSize = 10
  const market = await getSearchMarket()
  const out: LikedTrack[] = []

  for (let offset = 0; out.length < target; offset += pageSize) {
    const params = new URLSearchParams({
      q: query.trim(),
      type: 'track',
      limit: String(pageSize),
      offset: String(offset),
    })
    if (market) params.set('market', market)

    const data = await request<{
      tracks: { items: SearchTrackItem[]; total: number }
    }>(`/search?${params}`)

    const items = (data?.tracks.items ?? []).filter(
      (t): t is NonNullable<SearchTrackItem> => Boolean(t?.uri),
    )
    if (!items.length) break

    for (const t of items) {
      out.push(mapSearchItem(t))
      if (out.length >= target) break
    }

    if (items.length < pageSize) break
    if (offset + pageSize >= (data?.tracks.total ?? 0)) break
  }

  return out
}

export type RepeatMode = 'off' | 'track' | 'context'

export async function setRepeat(state: RepeatMode, deviceId?: string): Promise<void> {
  const q = new URLSearchParams({ state })
  if (deviceId) q.set('device_id', deviceId)
  await request(`/me/player/repeat?${q}`, { method: 'PUT' })
}

export async function playUris(
  deviceId: string,
  uris: string[],
  offsetUri?: string,
): Promise<void> {
  await request(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uris,
      ...(offsetUri ? { offset: { uri: offsetUri } } : {}),
    }),
  })
}

export function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatAdded(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
