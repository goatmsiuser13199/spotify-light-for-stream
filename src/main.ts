import './style.css'
import {
  ensureToken,
  forceRelogin,
  getClientId,
  handleCallback,
  loadClientId,
  login,
  logout,
  saveClientId,
} from './auth'
import {
  fetchLikedTracks,
  getDevices,
  getSearchMarket,
  playUris,
  searchTracks,
  setRepeat,
  transferPlayback,
  type LikedTrack,
} from './api'
import {
  activateAndTransfer,
  destroyPlayer,
  getDeviceId,
  getSavedVolume,
  initPlayer,
  loadSavedVolume,
  nextTrack,
  previousTrack,
  seek,
  setVolume,
  togglePlay,
  type TrackInfo,
} from './player'
import {
  applyAudioOutput,
  getPreferredSink,
  hookAudioContexts,
  listAudioOutputs,
  openWindowsSoundSettings,
  reapplyPreferredSink,
} from './audioOutput'
import { installGlobalErrorHandlers, log, openLogFolder, setUiHidden } from './log'
import { renderApp, renderLogin, type UiHandles } from './ui'

installGlobalErrorHandlers()

const app = document.querySelector<HTMLElement>('#app')!

let ui: UiHandles | null = null
let liked: LikedTrack[] = []
let list: LikedTrack[] = []
let mode: 'liked' | 'search' = 'liked'
let current: TrackInfo | null = null
let repeatOn = false
let searchSeq = 0
/** Quand la fenêtre est cachée, on coupe juste les maj UI — pas le SDK (ça crashait). */
let uiPaused = false
let tickTimer: number | undefined
let tickOrigin = 0
let tickPosition = 0
let tickDuration = 0
/** Throttle UI : le SDK spam player_state_changed plusieurs fois / s. */
let lastUiPaint = 0
let lastPaintedUri: string | null = null
let lastPaintedPaused: boolean | null = null

function startProgressTick(track: TrackInfo): void {
  window.clearInterval(tickTimer)
  if (track.paused || uiPaused) return
  tickOrigin = performance.now()
  tickPosition = track.positionMs
  tickDuration = track.durationMs
  let lastSec = Math.floor(track.positionMs / 1000)
  // 2 s suffit pour la barre ; moins de wakeups WebView
  tickTimer = window.setInterval(() => {
    if (uiPaused) {
      window.clearInterval(tickTimer)
      return
    }
    const pos = Math.min(
      tickPosition + (performance.now() - tickOrigin),
      tickDuration,
    )
    const sec = Math.floor(pos / 1000)
    if (sec === lastSec) return
    lastSec = sec
    ui?.setProgress(pos, tickDuration)
  }, 2000)
}

function showLiked(): void {
  mode = 'liked'
  list = liked
  ui?.setMode('liked', `${liked.length} titre${liked.length > 1 ? 's' : ''}`)
  ui?.setTracks(list, current?.uri ?? null)
}

function showSearch(tracks: LikedTrack[], q: string): void {
  mode = 'search'
  list = tracks
  ui?.setMode('search', `${tracks.length} résultat${tracks.length > 1 ? 's' : ''} pour « ${q} »`)
  ui?.setTracks(list, current?.uri ?? null)
}

async function playFrom(uri?: string): Promise<void> {
  const deviceId = getDeviceId()
  if (!deviceId) {
    ui?.setStatus('Appareil pas prêt', true)
    return
  }
  const uris = list.map((t) => t.uri)
  if (!uris.length) {
    ui?.setStatus('Aucun titre à lire', true)
    return
  }
  log.info('playFrom', { uri, count: uris.length })
  await playUris(deviceId, uris, uri)
  ui?.setStatus('')
}

function watchVisibility(): void {
  document.addEventListener('visibilitychange', () => {
    uiPaused = document.hidden
    if (uiPaused) {
      window.clearInterval(tickTimer)
    } else if (current && !current.paused) {
      startProgressTick(current)
    }
    void setUiHidden(uiPaused)
  })
  void setUiHidden(document.hidden)
}

async function boot(): Promise<void> {
  log.info('boot start')
  await loadSavedVolume()
  ui = renderApp(app, {
    onPlayAll: () => void playFrom().catch((e: Error) => {
      log.error('playAll', e)
      ui?.setStatus(e.message, true)
    }),
    onPrev: () => void previousTrack().catch((e: Error) => log.error('prev', e)),
    onToggle: () => void togglePlay().catch((e: Error) => log.error('toggle', e)),
    onNext: () => void nextTrack().catch((e: Error) => log.error('next', e)),
    onRepeat: () => {
      void (async () => {
        const next = !repeatOn
        const deviceId = getDeviceId() ?? undefined
        await setRepeat(next ? 'track' : 'off', deviceId)
        repeatOn = next
        ui?.setRepeatActive(repeatOn)
        log.info('repeat', { on: repeatOn })
      })().catch((e: Error) => {
        log.error('repeat', e)
        ui?.setStatus(e.message, true)
      })
    },
    onSeek: (ms) => {
      void seek(ms)
        .then(() => {
          tickPosition = ms
          tickOrigin = performance.now()
          ui?.setProgress(ms, tickDuration || current?.durationMs || 0)
        })
        .catch((e: Error) => log.error('seek', e))
    },
    onVolume: (v) => {
      void setVolume(v).catch((e: Error) => log.error('volume', e))
    },
    onSearch: (q) => {
      const query = q.trim()
      if (!query) {
        showLiked()
        ui?.setStatus('')
        return
      }
      const seq = ++searchSeq
      ui?.setStatus('Recherche…')
      void searchTracks(query)
        .then((tracks) => {
          if (seq !== searchSeq) return
          showSearch(tracks, query)
          ui?.setStatus('')
          log.info('search ok', { q: query, n: tracks.length })
        })
        .catch((e: Error) => {
          if (seq !== searchSeq) return
          log.error('search', e)
          ui?.setStatus(e.message, true)
        })
    },
    onPickTrack: (uri) => void playFrom(uri).catch((e: Error) => {
      log.error('pick', e)
      ui?.setStatus(e.message, true)
    }),
    onLogout: () => {
      log.info('logout')
      destroyPlayer()
      logout()
      window.location.reload()
    },
    onOpenSettings: () => {
      void (async () => {
        const [devices, outs] = await Promise.all([getDevices(), listAudioOutputs()])
        ui?.setDevices(devices, getDeviceId())
        ui?.setAudioOutputs(outs, getPreferredSink())
        log.info('audio outs', outs.map((o) => o.label))
      })().catch((e: Error) => {
        log.error('settings', e)
        ui?.setStatus(e.message, true)
      })
    },
    onPickDevice: (id) => {
      void transferPlayback(id, true)
        .then(() => {
          log.info('connect device', id)
          ui?.setStatus('Appareil Spotify Connect sélectionné')
        })
        .catch((e: Error) => {
          log.error('connect device', e)
          ui?.setStatus(e.message, true)
        })
    },
    onPickAudioOut: (id) => {
      void (async () => {
        const r = await applyAudioOutput(id)
        // WebView2 crée parfois la session audio un peu après : 2e passe
        await new Promise((res) => setTimeout(res, 600))
        const r2 = await applyAudioOutput(id)
        const ok = r.ok || r2.ok
        log.info('audio out', { id, ok, msg: r2.message || r.message })
        if (ok) {
          ui?.setStatus(r2.message || r.message || 'Sortie PC changée')
        } else {
          ui?.setStatus(
            r2.message ||
              r.message ||
              'Lance une piste, puis re-choisis la sortie PC',
            true,
          )
        }
      })().catch((e: Error) => {
        log.error('audio out', e)
        ui?.setStatus(e.message, true)
      })
    },
    onOpenLogs: () => {
      void openLogFolder().catch((e: Error) => ui?.setStatus(e.message, true))
    },
    onRelogin: () => {
      void forceRelogin().catch((e: Error) => {
        log.error('relogin', e)
        ui?.setStatus(e.message, true)
      })
    },
    onOpenSoundSettings: () => {
      void openWindowsSoundSettings().catch((e: Error) => ui?.setStatus(e.message, true))
    },
    onRefreshLikes: () => {
      void loadLikes()
    },
  })

  hookAudioContexts()
  // Appliquer la sortie mémorisée (nécessite souvent qu’une piste ait déjà joué)
  void applyAudioOutput(getPreferredSink()).then((r) => {
    if (!r.ok) log.warn('sink init', r.message)
    else log.info('sink init', r.message)
  })
  watchVisibility()
  ui.setLoading(true)
  ui.setStatus('Connexion lecteur…')

  await initPlayer({
    onReady: (deviceId) => {
      log.info('player ready', deviceId)
      ui?.setStatus('')
      void (async () => {
        await activateAndTransfer(false).catch((e) => log.warn('transfer', e))
        await setVolume(getSavedVolume()).catch(() => undefined)
        reapplyPreferredSink()
      })()
    },
    onState: (track) => {
      current = track
      if (uiPaused) {
        window.clearInterval(tickTimer)
        return
      }
      if (!track) {
        window.clearInterval(tickTimer)
        ui?.renderNow(null)
        lastPaintedUri = null
        lastPaintedPaused = null
        return
      }
      const now = Date.now()
      const metaChanged =
        track.uri !== lastPaintedUri || track.paused !== lastPaintedPaused
      // métadonnées tout de suite ; sinon au plus toutes les 2 s (position)
      if (metaChanged || now - lastUiPaint > 2000) {
        lastUiPaint = now
        lastPaintedUri = track.uri
        lastPaintedPaused = track.paused
        ui?.renderNow(track)
      }
      if (track.paused) window.clearInterval(tickTimer)
      else startProgressTick(track)
    },
    onError: (message) => {
      log.error('player', message)
      if (!uiPaused) ui?.setStatus(message, true)
    },
  })

  await loadLikes()
}

async function loadLikes(): Promise<void> {
  if (!ui) return
  ui.setLoading(true)
  try {
    await getSearchMarket().catch(() => undefined)
    const result = await fetchLikedTracks()
    liked = result.tracks
    ui.setLoading(false)
    if (mode === 'liked') showLiked()
    log.info('liked loaded', { n: liked.length, total: result.total })
    if (!liked.length) {
      ui.setStatus(
        `Aucun like ici (total Spotify=${result.total}). Reconnecter Spotify si mauvais compte.`,
        true,
      )
    } else {
      ui.setStatus('')
    }
  } catch (e) {
    ui.setLoading(false)
    const msg = e instanceof Error ? e.message : String(e)
    log.error('boot library', e)
    ui.setStatus(msg, true)
  }
}

function showLogin(errorMsg?: string): void {
  renderLogin(app, {
    initialClientId: getClientId(),
    onSaveClientId: (id) => saveClientId(id),
    onLogin: () =>
      void login().catch((e: Error) => {
        log.error('login', e)
        const status = app.querySelector('#status')
        if (status) {
          status.textContent = e.message
          status.classList.add('error')
        }
      }),
  })
  if (errorMsg) {
    const status = app.querySelector('#status')
    if (status) {
      status.textContent = errorMsg
      status.classList.add('error')
    }
  }
}

async function main(): Promise<void> {
  try {
    await loadClientId()

    if (window.location.pathname.startsWith('/callback')) {
      await handleCallback()
    }

    const token = await ensureToken()
    if (!token) {
      showLogin()
      return
    }

    await boot()
  } catch (e) {
    log.error('main', e)
    const message = e instanceof Error ? e.message : String(e)
    showLogin(message)
  }
}

void main()
