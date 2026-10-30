/// <reference types="vite/client" />

interface Window {
  onSpotifyWebPlaybackSDKReady: () => void
  Spotify: typeof Spotify
}

declare namespace Spotify {
  interface PlayerInit {
    name: string
    getOAuthToken: (cb: (token: string) => void) => void
    volume?: number
    enableMediaSession?: boolean
  }

  interface Error {
    message: string
  }

  interface PlaybackTrack {
    uri: string
    id: string | null
    type: string
    media_type: string
    name: string
    is_playable: boolean
    album: {
      uri: string
      name: string
      images: Array<{ url: string; height?: number; width?: number }>
    }
    artists: Array<{ uri: string; name: string }>
    duration_ms: number
  }

  interface PlaybackTrackWindow {
    current_track: PlaybackTrack
    previous_tracks: PlaybackTrack[]
    next_tracks: PlaybackTrack[]
  }

  interface PlaybackState {
    context: {
      uri: string | null
      metadata: Record<string, unknown>
    }
    disallows: Record<string, boolean>
    paused: boolean
    position: number
    repeat_mode: number
    shuffle: boolean
    track_window: PlaybackTrackWindow
    duration: number
  }

  type PlayerEvent =
    | 'ready'
    | 'not_ready'
    | 'player_state_changed'
    | 'initialization_error'
    | 'authentication_error'
    | 'account_error'
    | 'playback_error'

  interface Player {
    connect(): Promise<boolean>
    disconnect(): void
    addListener(
      event: 'ready' | 'not_ready',
      cb: (data: { device_id: string }) => void,
    ): boolean
    addListener(
      event: 'player_state_changed',
      cb: (state: PlaybackState | null) => void,
    ): boolean
    addListener(
      event:
        | 'initialization_error'
        | 'authentication_error'
        | 'account_error'
        | 'playback_error',
      cb: (error: Error) => void,
    ): boolean
    removeListener(event: PlayerEvent, cb?: (...args: unknown[]) => void): boolean
    getCurrentState(): Promise<PlaybackState | null>
    setName(name: string): Promise<void>
    getVolume(): Promise<number>
    setVolume(volume: number): Promise<void>
    pause(): Promise<void>
    resume(): Promise<void>
    togglePlay(): Promise<void>
    seek(positionMs: number): Promise<void>
    previousTrack(): Promise<void>
    nextTrack(): Promise<void>
    activateElement(): Promise<void>
  }

  const Player: {
    new (options: PlayerInit): Player
  }
}
