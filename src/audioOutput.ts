const KEY = 'sl_audio_sink'

export type AudioOut = {
  deviceId: string
  label: string
}

let preferredSink = localStorage.getItem(KEY) ?? 'default'
// Anciens ids navigateur (hash) ≠ ids Windows — on repartira de default si inconnu

export function getPreferredSink(): string {
  return preferredSink
}

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

/** No-op côté Web : le routage réel est Windows natif (voir set_windows_audio_output). */
export function hookAudioContexts(): void {
  /* volontairement vide — setSinkId ne marche pas avec le SDK Spotify */
}

export async function primeAudioPermissions(): Promise<void> {
  /* plus nécessaire pour la liste native */
}

export async function listAudioOutputs(): Promise<AudioOut[]> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const outs = await invoke<Array<{ device_id: string; label: string }>>(
        'list_windows_audio_outputs',
      )
      const mapped = outs.map((o) => ({ deviceId: o.device_id, label: o.label }))
      if (!mapped.some((o) => o.deviceId === preferredSink)) {
        preferredSink = 'default'
        localStorage.setItem(KEY, 'default')
      }
      return mapped
    } catch (e) {
      console.warn('[sink] list native failed', e)
    }
  }

  return [{ deviceId: 'default', label: 'Sortie par défaut Windows' }]
}

export type ApplySinkResult = {
  ok: boolean
  message: string
}

/** Applique la sortie via l’API Windows (par processus app + WebView2). */
export async function applyAudioOutput(sinkId: string): Promise<ApplySinkResult> {
  preferredSink = sinkId
  localStorage.setItem(KEY, sinkId)

  if (!isTauri()) {
    return { ok: false, message: 'Hors Tauri — sortie PC indisponible' }
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const message = await invoke<string>('set_windows_audio_output', {
      deviceId: sinkId,
    })
    console.info('[sink] windows', message)
    return { ok: true, message }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[sink] windows failed', message)
    return { ok: false, message }
  }
}

export function reapplyPreferredSink(): void {
  void applyAudioOutput(preferredSink)
}

export async function openWindowsSoundSettings(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_windows_sound_settings')
}
