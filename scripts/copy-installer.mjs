import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const dest = join(root, 'Spotify-Light-Setup.exe')
const candidates = []

const dirs = [
  join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis'),
  join(process.env.TEMP || process.env.TMP || '', 'sl-cargo-target', 'release', 'bundle', 'nsis'),
].filter(Boolean)

for (const dir of dirs) {
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('-setup.exe')) continue
    const full = join(dir, name)
    candidates.push({ full, mtime: statSync(full).mtimeMs })
  }
}

if (!candidates.length) {
  console.error('Aucun installateur NSIS trouvé. Lance npm run desktop:build d’abord.')
  process.exit(1)
}

candidates.sort((a, b) => b.mtime - a.mtime)
copyFileSync(candidates[0].full, dest)
console.log('Installateur →', dest)

const clutter = join(root, 'dist-install')
if (existsSync(clutter)) rmSync(clutter, { recursive: true, force: true })

// Ancien nom avec espaces à la racine
for (const name of readdirSync(root)) {
  if (name !== 'Spotify-Light-Setup.exe' && name.endsWith('-setup.exe')) {
    rmSync(join(root, name), { force: true })
  }
}
