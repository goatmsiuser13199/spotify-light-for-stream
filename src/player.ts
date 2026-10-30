import { ensureToken } from './auth'
import { transferPlayback } from './api'

export type TrackInfo = {
  uri: string
  name: string
  artists: string
  album: string
  artUrl: string
  durationMs: number
  positionMs: number
  paused: boolean
}

type PlayerCallbacks = {
  onReady: (deviceId: string) => void
  onState: (track: TrackInfo | null) => void
  onError: (message: string) => void
}

const VOLUME_KEY = 'sl_volume'
const PREF_VOLUME = 'volume'

let player: Spotify.Player | null = null
let deviceId: string | null = null
let sdkReady: Promise<void> | null = null
let callbacks: PlayerCallbacks | null = null
let suspended = false
let connecting: Promise<void> | null = null
/** Cache sync pour l’UI (évite await au 1er paint). */
let volumeCache = 0.8
let volumeReady: Promise<void> | null = null

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

function readLocalVolume(): number {
  const raw = localStorage.getItem(VOLUME_KEY)
  if (raw == null) return 0.8
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0.8
  return Math.min(1, Math.max(0, n))
}

/** Charge le volume depuis le disque (Tauri) + localStorage. À appeler au boot. */
export async function loadSavedVolume(): Promise<number> {
  if (!volumeReady) {
    volumeReady = (async () => {
      let v = readLocalVolume()
      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const stored = await invoke<string | null>('get_pref', { key: PREF_VOLUME })
          if (stored != null) {
            const n = Number(stored)
            if (Number.isFinite(n)) v = Math.min(1, Math.max(0, n))
          }
        } catch {
          /* fallback localStorage */
        }
      }
      volumeCache = v
      localStorage.setItem(VOLUME_KEY, String(v))
    })()
  }
  await volumeReady
  return volumeCache
}

/** Volume mémorisé (0–1), défaut 0.8. Sync après loadSavedVolume(). */
export function getSavedVolume(): number {
  return volumeCache
}

export function saveVolume(volume: number): void {
  const v = Math.min(1, Math.max(0, volume))
  volumeCache = v
  localStorage.setItem(VOLUME_KEY, String(v))
  if (isTauri()) {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('set_pref', { key: PREF_VOLUME, value: String(v) }))
      .catch(() => undefined)
  }
}

function loadSdkScript(): void {
  if (document.querySelector('script[data-spotify-sdk]')) return
  const s = document.createElement('script')
  s.src = 'https://sdk.scdn.co/spotify-player.js'
  s.async = true
  s.dataset.spotifySdk = '1'
  document.head.appendChild(s)
}

function waitForSdk(): Promise<void> {
  if (window.Spotify?.Player) return Promise.resolve()
  if (sdkReady) return sdkReady

  sdkReady = new Promise((resolve) => {
    const prev = window.onSpotifyWebPlaybackSDKReady
    window.onSpotifyWebPlaybackSDKReady = () => {
      prev?.()
      resolve()
    }
    loadSdkScript()
  })

  return sdkReady
}

function mapState(state: Spotify.PlaybackState | null): TrackInfo | null {
  if (!state?.track_window?.current_track) return null
  const t = state.track_window.current_track
  return {
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => a.name).join(', '),
    album: t.album.name,
    artUrl: t.album.images[0]?.url ?? '',
    durationMs: state.duration || t.duration_ms,
    positionMs: state.position,
    paused: state.paused,
  }
}

function wirePlayer(instance: Spotify.Player): void {
  instance.addListener('ready', ({ device_id }) => {
    deviceId = device_id
    callbacks?.onReady(device_id)
  })

  instance.addListener('not_ready', () => {
    if (!suspended) callbacks?.onError('Appareil hors ligne')
  })

  instance.addListener('player_state_changed', (state) => {
    if (suspended) return
    callbacks?.onState(mapState(state))
  })

  instance.addListener('initialization_error', ({ message }) =>
    callbacks?.onError(message),
  )
  instance.addListener('authentication_error', ({ message }) =>
    callbacks?.onError(message),
  )
  instance.addListener('account_error', ({ message }) =>
    callbacks?.onError(`${message} (Premium requis)`),
  )
  instance.addListener('playback_error', ({ message }) =>
    callbacks?.onError(message),
  )
}

async function createAndConnect(): Promise<void> {
  await waitForSdk()
  await loadSavedVolume()

  player = new window.Spotify.Player({
    name: 'Spotify Light',
    volume: getSavedVolume(),
    getOAuthToken: (done) => {
      void ensureToken().then((token) => {
        if (token) done(token)
        else callbacks?.onError('Session expirée — reconnecte-toi')
      })
    },
  })

  wirePlayer(player)
  const ok = await player.connect()
  if (!ok) callbacks?.onError('Connexion au lecteur impossible')
  // Le SDK ignore parfois le volume du constructeur
  await player.setVolume(getSavedVolume()).catch(() => undefined)
}

export async function initPlayer(cb: PlayerCallbacks): Promise<void> {
  callbacks = cb
  suspended = false
  await createAndConnect()
}

export function getDeviceId(): string | null {
  return deviceId
}

export function isSuspended(): boolean {
  return suspended
}

/** Coupe le SDK (websocket + audio) → ~0% CPU. */
export async function suspendPlayback(): Promise<boolean> {
  if (suspended || !player) return false

  let wasPlaying = false
  try {
    const state = await player.getCurrentState()
    wasPlaying = Boolean(state && !state.paused)
    if (wasPlaying) await player.pause()
  } catch {
    /* ignore */
  }

  suspended = true
  player.disconnect()
  player = null
  deviceId = null
  return wasPlaying
}

/** Recrée le lecteur après un suspend. */
export async function resumePlaybackSession(autoplay: boolean): Promise<void> {
  if (!suspended && player) return
  if (connecting) return connecting

  connecting = (async () => {
    suspended = false
    await createAndConnect()

    const started = Date.now()
    while (!deviceId && Date.now() - started < 4000) {
      await new Promise((r) => setTimeout(r, 50))
    }

    if (deviceId) {
      await player?.activateElement()
      await transferPlayback(deviceId, autoplay).catch(() => undefined)
      await player?.setVolume(getSavedVolume()).catch(() => undefined)
    }
  })()

  try {
    await connecting
  } finally {
    connecting = null
  }
}

export async function activateAndTransfer(play = false): Promise<void> {
  if (!player || !deviceId || suspended) return
  await player.activateElement()
  await transferPlayback(deviceId, play)
  await player.setVolume(getSavedVolume()).catch(() => undefined)
}

export async function togglePlay(): Promise<void> {
  if (suspended) await resumePlaybackSession(true)
  await player?.togglePlay()
}

export async function nextTrack(): Promise<void> {
  if (suspended) await resumePlaybackSession(true)
  await player?.nextTrack()
}

export async function previousTrack(): Promise<void> {
  if (suspended) await resumePlaybackSession(true)
  await player?.previousTrack()
}

export async function setVolume(volume: number): Promise<void> {
  const v = Math.min(1, Math.max(0, volume))
  saveVolume(v)
  if (suspended || !player) return
  await player.setVolume(v)
}

export async function seek(positionMs: number): Promise<void> {
  if (suspended || !player) return
  await player.seek(Math.max(0, Math.floor(positionMs)))
}

export function destroyPlayer(): void {
  suspended = true
  player?.disconnect()
  player = null
  deviceId = null
  callbacks = null
}
