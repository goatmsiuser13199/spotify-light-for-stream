import { formatAdded, formatMs, type LikedTrack, type SpotifyDevice } from './api'
import type { AudioOut } from './audioOutput'
import { getSavedVolume, type TrackInfo } from './player'

function icon(
  name: 'play' | 'pause' | 'prev' | 'next' | 'heart' | 'vol' | 'gear' | 'repeat' | 'search',
): string {
  const map: Record<string, string> = {
    play: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>`,
    pause: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/></svg>`,
    prev: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z"/></svg>`,
    next: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2V6zM5 18l8.5-6L5 6v12z"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.2-4.6-9.5-8.2C.8 10.1 1.6 6.8 4.6 5.5c2-.9 4.1-.2 5.4 1.4C11.3 5.3 13.4 4.6 15.4 5.5c3 1.3 3.8 4.6 2.1 7.3C19.2 16.4 12 21 12 21z"/></svg>`,
    vol: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.3-3.9v7.8A4.5 4.5 0 0 0 16.5 12z"/></svg>`,
    gear: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.1 7.1 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64L4.86 10.7c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.4 1.05.71 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.24.1.51 0 .64-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg>`,
    repeat: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>`,
    search: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 5L20.49 19l-5-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`,
  }
  return map[name]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export type UiHandles = {
  setStatus: (msg: string, isError?: boolean) => void
  setTracks: (tracks: LikedTrack[], activeUri: string | null) => void
  setLoading: (loading: boolean) => void
  renderNow: (track: TrackInfo | null) => void
  setProgress: (positionMs: number, durationMs: number) => void
  setDevices: (devices: SpotifyDevice[], activeId: string | null) => void
  setAudioOutputs: (outputs: AudioOut[], activeId: string) => void
  setRepeatActive: (on: boolean) => void
  setMode: (mode: 'liked' | 'search', countLabel: string) => void
  getSearchQuery: () => string
}

export function renderLogin(
  root: HTMLElement,
  handlers: {
    onLogin: () => void
    onSaveClientId: (id: string) => void | Promise<void>
    initialClientId: string
  },
): void {
  const hasId = Boolean(handlers.initialClientId)
  root.innerHTML = `
    <section class="setup">
      <h1>Spotify Light</h1>
      <p>Premium requis. Guide : <code>README.md</code></p>
      <ol class="setup-steps">
        <li><a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Dashboard</a> → Create app</li>
        <li>Redirect URI : <code>http://127.0.0.1:5173/callback</code></li>
        <li>Settings → copie le <strong>Client ID</strong> ici</li>
      </ol>
      <label class="setup-field">
        <span>Client ID</span>
        <input id="client-id" type="text" spellcheck="false" autocomplete="off"
          placeholder="ex. a1b2c3d4…" value="${escapeHtml(handlers.initialClientId)}" />
      </label>
      <button type="button" class="btn" id="save-id" style="width:100%;margin-bottom:10px;height:40px">
        Enregistrer le Client ID
      </button>
      <button class="btn btn-play" id="login-btn" ${hasId ? '' : 'disabled'} style="width:100%;border-radius:999px;height:44px">
        Connexion Spotify
      </button>
      <p class="status-line" id="status"></p>
    </section>
  `

  const idInput = root.querySelector('#client-id') as HTMLInputElement
  const loginBtn = root.querySelector('#login-btn') as HTMLButtonElement
  const status = root.querySelector('#status') as HTMLElement

  root.querySelector('#save-id')?.addEventListener('click', () => {
    void Promise.resolve(handlers.onSaveClientId(idInput.value))
      .then(() => {
        loginBtn.disabled = false
        status.textContent = 'Client ID enregistré — tu peux te connecter'
        status.classList.remove('error')
      })
      .catch((e: Error) => {
        status.textContent = e.message
        status.classList.add('error')
      })
  })

  loginBtn.addEventListener('click', handlers.onLogin)
}

export function renderApp(
  root: HTMLElement,
  handlers: {
    onPlayAll: () => void
    onPrev: () => void
    onToggle: () => void
    onNext: () => void
    onRepeat: () => void
    onSeek: (ms: number) => void
    onVolume: (v: number) => void
    onSearch: (q: string) => void
    onPickTrack: (uri: string) => void
    onLogout: () => void
    onOpenSettings: () => void
    onPickDevice: (id: string) => void
    onPickAudioOut: (id: string) => void
    onOpenLogs: () => void
    onRelogin: () => void
    onOpenSoundSettings: () => void
    onRefreshLikes: () => void
  },
): UiHandles {
  root.innerHTML = `
    <div class="main">
      <div class="topbar">
        <label class="search-bar">
          <span class="search-ico" aria-hidden="true">${icon('search')}</span>
          <input id="search" type="search" placeholder="Que souhaitez-vous écouter ?" autocomplete="off" />
        </label>
      </div>

      <header class="hero" id="hero">
        <div class="hero-top">
          <div class="hero-cover" aria-hidden="true">${icon('heart')}</div>
          <div class="hero-meta">
            <p class="eyebrow" id="eyebrow">Playlist</p>
            <h1 id="heading">Titres likés</h1>
            <p class="sub" id="count">Chargement…</p>
          </div>
        </div>
      </header>

      <div class="toolbar">
        <button class="btn btn-play" id="play-all" aria-label="Lecture">${icon('play')}</button>
      </div>

      <p class="status-line" id="status"></p>
      <div class="loading" id="loading">Chargement de tes likes…</div>
      <table class="tracks" id="table" hidden>
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th class="col-title">Titre</th>
            <th class="col-album">Album</th>
            <th class="col-date">Ajouté le</th>
            <th class="col-dur">⏱</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
      <div class="empty" id="empty" hidden>
        <p>Aucun titre liké sur ce compte Spotify.</p>
        <p class="empty-hint">Reconnecte-toi si tu es sur le mauvais compte.</p>
        <div class="empty-actions">
          <button type="button" class="btn" id="refresh-likes">Recharger</button>
          <button type="button" class="btn btn-play" id="relogin-empty" style="width:auto;padding:10px 18px;height:auto">Reconnecter Spotify</button>
        </div>
      </div>
    </div>

    <footer class="player">
      <div class="now">
        <div class="ph" id="art-ph">—</div>
        <img id="art" alt="" hidden />
        <div class="meta">
          <p class="title" id="now-title">Rien en lecture</p>
          <p class="artists" id="now-artists">Choisis un titre</p>
        </div>
      </div>

      <div class="center-controls">
        <div class="controls">
          <button class="icon-btn" id="prev" aria-label="Précédent">${icon('prev')}</button>
          <button class="icon-btn play" id="toggle" aria-label="Lecture">${icon('play')}</button>
          <button class="icon-btn" id="next" aria-label="Suivant">${icon('next')}</button>
          <button class="icon-btn" id="repeat" aria-label="Répéter" title="Boucle titre">${icon('repeat')}</button>
        </div>
        <div class="seek">
          <span class="t" id="t-pos">0:00</span>
          <input id="seek" type="range" min="0" max="1000" value="0" />
          <span class="t end" id="t-dur">0:00</span>
        </div>
      </div>

      <div class="right-tools">
        <div class="volume" title="Volume">
          ${icon('vol')}
          <input id="volume" type="range" min="0" max="100" value="${Math.round(getSavedVolume() * 100)}" />
        </div>
        <div class="settings-wrap">
          <button class="icon-btn" id="settings" aria-label="Paramètres">${icon('gear')}</button>
          <div class="menu" id="menu">
            <div class="menu-label">Sortie PC (casque / HDMI / écran)</div>
            <div id="audio-outs"></div>
            <hr />
            <div class="menu-label">Spotify Connect (autre app / enceinte Wi‑Fi)</div>
            <div id="devices"></div>
            <hr />
            <button type="button" id="sound-settings">Réglages son Windows…</button>
            <button type="button" id="relogin">Reconnecter Spotify (likes)</button>
            <button type="button" id="open-logs">Ouvrir les logs</button>
            <button type="button" id="logout">Déconnexion</button>
          </div>
        </div>
      </div>
    </footer>
  `

  const statusEl = root.querySelector('#status') as HTMLElement
  const loadingEl = root.querySelector('#loading') as HTMLElement
  const emptyEl = root.querySelector('#empty') as HTMLElement
  const tableEl = root.querySelector('#table') as HTMLTableElement
  const tbody = root.querySelector('#tbody') as HTMLTableSectionElement
  const countEl = root.querySelector('#count') as HTMLElement
  const searchEl = root.querySelector('#search') as HTMLInputElement
  const eyebrowEl = root.querySelector('#eyebrow') as HTMLElement
  const headingEl = root.querySelector('#heading') as HTMLElement
  const artEl = root.querySelector('#art') as HTMLImageElement
  const artPh = root.querySelector('#art-ph') as HTMLElement
  const nowTitle = root.querySelector('#now-title') as HTMLElement
  const nowArtists = root.querySelector('#now-artists') as HTMLElement
  const toggleBtn = root.querySelector('#toggle') as HTMLButtonElement
  const volumeEl = root.querySelector('#volume') as HTMLInputElement
  const menu = root.querySelector('#menu') as HTMLElement
  const devicesEl = root.querySelector('#devices') as HTMLElement
  const audioOutsEl = root.querySelector('#audio-outs') as HTMLElement

  root.querySelector('#play-all')?.addEventListener('click', handlers.onPlayAll)
  root.querySelector('#prev')?.addEventListener('click', handlers.onPrev)
  root.querySelector('#next')?.addEventListener('click', handlers.onNext)
  root.querySelector('#repeat')?.addEventListener('click', handlers.onRepeat)
  toggleBtn.addEventListener('click', handlers.onToggle)
  const repeatBtn = root.querySelector('#repeat') as HTMLButtonElement
  const seekEl = root.querySelector('#seek') as HTMLInputElement
  const tPos = root.querySelector('#t-pos') as HTMLElement
  const tDur = root.querySelector('#t-dur') as HTMLElement
  let seeking = false

  seekEl.addEventListener('pointerdown', () => {
    seeking = true
  })
  const commitSeek = () => {
    seeking = false
    const duration = Number(seekEl.dataset.duration ?? 0)
    handlers.onSeek((Number(seekEl.value) / 1000) * duration)
  }
  seekEl.addEventListener('pointerup', commitSeek)
  seekEl.addEventListener('change', commitSeek)
  root.querySelector('#logout')?.addEventListener('click', handlers.onLogout)
  root.querySelector('#open-logs')?.addEventListener('click', handlers.onOpenLogs)
  root.querySelector('#relogin')?.addEventListener('click', handlers.onRelogin)
  root.querySelector('#sound-settings')?.addEventListener('click', handlers.onOpenSoundSettings)
  root.querySelector('#refresh-likes')?.addEventListener('click', handlers.onRefreshLikes)
  root.querySelector('#relogin-empty')?.addEventListener('click', handlers.onRelogin)

  root.querySelector('#settings')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const willOpen = !menu.classList.contains('open')
    menu.classList.toggle('open', willOpen)
    if (willOpen) handlers.onOpenSettings()
  })

  document.addEventListener('click', () => menu.classList.remove('open'))
  menu.addEventListener('click', (e) => e.stopPropagation())

  let searchTimer: number | undefined
  searchEl.addEventListener('input', () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => handlers.onSearch(searchEl.value), 320)
  })

  const emitVolume = () => handlers.onVolume(Number(volumeEl.value) / 100)
  volumeEl.addEventListener('input', emitVolume)
  volumeEl.addEventListener('change', emitVolume)

  let allTracks: LikedTrack[] = []
  let activeUri: string | null = null

  function paintRows(tracks: LikedTrack[]): void {
    countEl.textContent = `${tracks.length} titre${tracks.length > 1 ? 's' : ''}`
    emptyEl.hidden = tracks.length > 0
    tableEl.hidden = tracks.length === 0

    tbody.innerHTML = tracks
      .map((t, i) => {
        const active = t.uri === activeUri
        return `
        <tr data-uri="${escapeHtml(t.uri)}" class="${active ? 'active' : ''}">
          <td class="col-num">${i + 1}</td>
          <td class="col-title">
            <div class="track-title">
              ${t.artUrl ? `<img src="${escapeHtml(t.artUrl)}" alt="" loading="lazy" />` : '<span></span>'}
              <span class="names">
                <span class="name ${active ? 'playing' : ''}">${escapeHtml(t.name)}</span>
                <span class="artists">${escapeHtml(t.artists)}</span>
              </span>
            </div>
          </td>
          <td class="col-album">${escapeHtml(t.album)}</td>
          <td class="col-date">${escapeHtml(formatAdded(t.addedAt))}</td>
          <td class="col-dur">${formatMs(t.durationMs)}</td>
        </tr>`
      })
      .join('')

    tbody.querySelectorAll('tr[data-uri]').forEach((row) => {
      row.addEventListener('dblclick', () => {
        const uri = (row as HTMLElement).dataset.uri
        if (uri) handlers.onPickTrack(uri)
      })
      row.addEventListener('click', () => {
        const uri = (row as HTMLElement).dataset.uri
        if (uri) handlers.onPickTrack(uri)
      })
    })
  }

  return {
    setStatus(msg, isError = false) {
      statusEl.textContent = msg
      statusEl.classList.toggle('error', isError)
    },
    setLoading(loading) {
      loadingEl.hidden = !loading
      if (loading) {
        tableEl.hidden = true
        emptyEl.hidden = true
      }
    },
    setTracks(tracks, active) {
      allTracks = tracks
      activeUri = active
      paintRows(tracks)
    },
    renderNow(track) {
      if (!track) {
        nowTitle.textContent = 'Rien en lecture'
        nowArtists.textContent = 'Choisis un titre'
        artEl.hidden = true
        artPh.hidden = false
        toggleBtn.innerHTML = icon('play')
        return
      }
      if (nowTitle.textContent !== track.name) nowTitle.textContent = track.name
      if (nowArtists.textContent !== track.artists) nowArtists.textContent = track.artists
      toggleBtn.innerHTML = icon(track.paused ? 'play' : 'pause')
      if (track.artUrl && artEl.src !== track.artUrl) {
        artEl.src = track.artUrl
        artEl.hidden = false
        artPh.hidden = true
      }
      if (!seeking) {
        seekEl.dataset.duration = String(track.durationMs)
        seekEl.value = track.durationMs
          ? String(Math.round((track.positionMs / track.durationMs) * 1000))
          : '0'
        tPos.textContent = formatMs(track.positionMs)
        tDur.textContent = formatMs(track.durationMs)
      }
      if (track.uri !== activeUri) {
        activeUri = track.uri
        paintRows(allTracks)
      }
    },
    setProgress(positionMs, durationMs) {
      if (seeking) return
      seekEl.dataset.duration = String(durationMs)
      seekEl.value = durationMs
        ? String(Math.round((positionMs / durationMs) * 1000))
        : '0'
      tPos.textContent = formatMs(positionMs)
      tDur.textContent = formatMs(durationMs)
    },
    setDevices(devices, activeId) {
      if (!devices.length) {
        devicesEl.innerHTML = `<button type="button" disabled>Aucun appareil Connect</button>`
        return
      }
      devicesEl.innerHTML = devices
        .map(
          (d) => `
          <button type="button" class="device ${d.id === activeId ? 'active' : ''}" data-id="${escapeHtml(d.id)}">
            ${escapeHtml(d.name)} · ${escapeHtml(d.type)}
          </button>`,
        )
        .join('')

      devicesEl.querySelectorAll('button[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = (btn as HTMLElement).dataset.id
          if (id) {
            handlers.onPickDevice(id)
            menu.classList.remove('open')
          }
        })
      })
    },
    setAudioOutputs(outputs, activeId) {
      if (!outputs.length) {
        audioOutsEl.innerHTML = `<button type="button" disabled>Aucune sortie détectée</button>`
        return
      }
      audioOutsEl.innerHTML = outputs
        .map(
          (o) => `
          <button type="button" class="device ${o.deviceId === activeId ? 'active' : ''}" data-sink="${escapeHtml(o.deviceId)}">
            ${escapeHtml(o.label)}
          </button>`,
        )
        .join('')

      audioOutsEl.querySelectorAll('button[data-sink]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = (btn as HTMLElement).dataset.sink
          if (id !== undefined) {
            handlers.onPickAudioOut(id)
            menu.classList.remove('open')
          }
        })
      })
    },
    setRepeatActive(on) {
      repeatBtn.classList.toggle('active', on)
      repeatBtn.title = on ? 'Boucle activée' : 'Boucle titre'
    },
    setMode(mode, countLabel) {
      if (mode === 'search') {
        eyebrowEl.textContent = 'Recherche'
        headingEl.textContent = 'Résultats'
        emptyEl.innerHTML = '<p>Aucun résultat pour cette recherche.</p>'
      } else {
        eyebrowEl.textContent = 'Playlist'
        headingEl.textContent = 'Titres likés'
        emptyEl.innerHTML = `
          <p>Aucun titre liké sur ce compte Spotify.</p>
          <p class="empty-hint">Reconnecte-toi si tu es sur le mauvais compte.</p>
          <div class="empty-actions">
            <button type="button" class="btn" id="refresh-likes">Recharger</button>
            <button type="button" class="btn btn-play" id="relogin-empty" style="width:auto;padding:10px 18px;height:auto">Reconnecter Spotify</button>
          </div>`
        emptyEl.querySelector('#refresh-likes')?.addEventListener('click', handlers.onRefreshLikes)
        emptyEl.querySelector('#relogin-empty')?.addEventListener('click', handlers.onRelogin)
      }
      countEl.textContent = countLabel
    },
    getSearchQuery: () => searchEl.value,
  }
}
