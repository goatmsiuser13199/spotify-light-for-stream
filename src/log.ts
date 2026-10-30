type Level = 'info' | 'warn' | 'error'

const MAX_LINES = 80
const buf: string[] = []

function stamp(): string {
  return new Date().toISOString()
}

function push(level: Level, message: string, extra?: unknown): void {
  const line = extra !== undefined
    ? `${stamp()} [${level}] ${message} ${safe(extra)}`
    : `${stamp()} [${level}] ${message}`
  buf.push(line)
  if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES)

  // Disque uniquement pour les erreurs (invoke Tauri = coût CPU)
  if (level === 'error') {
    console.error(line)
    void persist(level, message, extra)
  } else if (level === 'warn') {
    console.warn(line)
  }
  // info : silence (pas de console spam en prod)
}

function safe(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function persist(level: Level, message: string, extra?: unknown): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const full = extra !== undefined ? `${message} | ${safe(extra)}` : message
    await invoke('append_log', { level, message: full })
  } catch {
    /* ignore */
  }
}

export const log = {
  info: (message: string, extra?: unknown) => push('info', message, extra),
  warn: (message: string, extra?: unknown) => push('warn', message, extra),
  error: (message: string, extra?: unknown) => push('error', message, extra),
  dump: () => buf.slice(),
}

export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (ev) => {
    log.error('window.error', {
      message: ev.message,
      file: ev.filename,
      line: ev.lineno,
      col: ev.colno,
    })
  })
  window.addEventListener('unhandledrejection', (ev) => {
    log.error('unhandledrejection', ev.reason)
  })
}

export async function openLogFolder(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_log_folder')
}

export async function setUiHidden(hidden: boolean): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_ui_hidden', { hidden })
  } catch {
    /* ignore */
  }
}
