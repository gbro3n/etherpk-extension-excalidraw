// Copy Excalidraw's fonts beside the bundle (`dist/fonts`), where the extension tells Excalidraw to
// find them (`window.EXCALIDRAW_ASSET_PATH`), so no font is ever fetched from anywhere else.
import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
if (!existsSync(from)) throw new Error(`Excalidraw's fonts are not at ${from}. Run pnpm install.`)
cpSync(from, join(root, 'dist/fonts'), { recursive: true })
console.log('Copied Excalidraw fonts to dist/fonts')
