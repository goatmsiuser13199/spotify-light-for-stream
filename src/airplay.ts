import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type AirplayKind = 'homepod' | 'appletv' | 'airportexpress' | 'otherairplay'

export type AirplayDevice = {
  id: string
  name: string
  host: string
  addresses: string[]
  port: number
  kind: AirplayKind
  model?: string | null
  features?: string | null
  supports_airplay2: boolean
}

export type StreamingInfo = {
  ip: string
  name: string
  sampleRate: number
  channels: number
  volume: number
}

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export function primaryIp(device: AirplayDevice): string | null {
  const list = device.addresses.map(String)
  const v4 = list.find((a) => a.includes('.') && !a.includes(':'))
  return v4 ?? list[0] ?? null
}

export function kindLabel(kind: AirplayKind): string {
  switch (kind) {
    case 'homepod':
      return 'HomePod'
    case 'appletv':
      return 'Apple TV'
    case 'airportexpress':
      return 'AirPort Express'
    default:
      return 'AirPlay'
  }
}

export async function startDiscovery(): Promise<void> {
  if (!isTauri()) return
  await invoke('start_discovery_stream')
}

export async function stopDiscovery(): Promise<void> {
  if (!isTauri()) return
  await invoke('stop_discovery_stream').catch(() => undefined)
}

export async function listenDevices(
  onDevice: (d: AirplayDevice) => void,
  onError: (msg: string) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined
  const unsubs: UnlistenFn[] = []
  unsubs.push(await listen<AirplayDevice>('airplay://device', (e) => onDevice(e.payload)))
  unsubs.push(await listen<string>('airplay://error', (e) => onError(e.payload)))
  return () => {
    for (const u of unsubs) u()
  }
}

export async function startStream(opts: {
  device: AirplayDevice
  volume: number
  playLocally: boolean
  /** Sortie Windows où joue l’app (même id que le menu gear). */
  captureDeviceId: string
}): Promise<StreamingInfo> {
  const ip = primaryIp(opts.device)
  if (!ip) throw new Error('Pas d’IP pour cet appareil')
  return invoke<StreamingInfo>('start_streaming', {
    ip,
    port: opts.device.port,
    name: opts.device.name,
    model: opts.device.model ?? null,
    features: opts.device.features ?? null,
    volume: opts.volume,
    playLocally: opts.playLocally,
    captureDeviceId: opts.captureDeviceId || 'default',
  })
}

export async function stopStream(): Promise<void> {
  await invoke('stop_streaming')
}

export async function setStreamVolume(volume: number): Promise<number> {
  return invoke<number>('set_stream_volume', { volume })
}

export async function setPlayLocally(playLocally: boolean): Promise<void> {
  await invoke('set_play_locally', { playLocally })
}

export async function getStreaming(): Promise<StreamingInfo | null> {
  if (!isTauri()) return null
  return invoke<StreamingInfo | null>('is_streaming')
}
