/**
 * The extension's bundle: `dist/main.js` (small, exporting `activate`), lazy chunks holding React and
 * Excalidraw, `dist/main.css` (Excalidraw's stylesheet and the extension's own), and `dist/fonts`
 * (copied by `scripts/copy-fonts.mjs`). The Client serves all of it from its own origin.
 *
 * Two things are changed on the way, both tied to Excalidraw 0.18.1, which is pinned exactly:
 *
 * - **Its stylesheet is scoped.** The extension mounts in the page (`"isolation": "page"`), where the
 *   Client adopts a stylesheet only when every rule styles an element with a class starting with
 *   `excalidraw`, or one inside it. A few of Excalidraw's rules do not (`.zoom-actions`, `:root`'s
 *   variables), and each gets `.excalidraw` put before the element it styles.
 * - **Its fonts come only from the extension.** Excalidraw gives every font a CDN address after the
 *   one it is told to use, which the Client's Content Security Policy refuses about 230 times a page,
 *   and it shrinks the fonts it embeds in an SVG with a WebAssembly tool whose loader calls
 *   `new Function`, which the Client refuses too. The CDN address is taken out, and fonts are embedded
 *   whole instead of shrunk.
 *
 * Either change failing to apply (another Excalidraw version) fails the build, rather than shipping
 * an extension the Client would refuse.
 */
import { defineConfig, type Plugin } from 'vitest/config'

import { scopeExcalidrawCss } from './scripts/scope-css'

/** Exact text in Excalidraw 0.18.1's production build, and what it becomes. */
const PATCHES: { name: string; find: string; replace: string }[] = [
    {
        name: 'fonts from the extension only',
        find: 'return r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),r',
        replace: 'return r',
    },
    {
        name: 'fonts embedded whole',
        find: 'qd=async(e,t)=>{',
        replace:
            'qd=async(e,t)=>{{let u=new Uint8Array(e),s="";for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));return"data:font/woff2;base64,"+btoa(s)}',
    },
]

function patchExcalidraw(): Plugin {
    const applied = new Set<string>()
    return {
        name: 'etherpk-patch-excalidraw',
        enforce: 'pre',
        transform(code, id) {
            if (!id.includes('@excalidraw/excalidraw/dist/prod/')) return null
            let out = code
            for (const patch of PATCHES) {
                if (!out.includes(patch.find)) continue
                out = out.replace(patch.find, patch.replace)
                applied.add(patch.name)
            }
            return out === code ? null : { code: out, map: null }
        },
        buildEnd() {
            const missing = PATCHES.filter((patch) => !applied.has(patch.name)).map((patch) => patch.name)
            if (missing.length > 0) throw new Error(`Excalidraw could not be patched (${missing.join(', ')}): check the pinned version.`)
        },
    }
}

export default defineConfig({
    plugins: [patchExcalidraw()],
    css: {
        postcss: { plugins: [scopeExcalidrawCss()] },
    },
    define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
    },
    resolve: {
        conditions: ['production', 'import', 'module', 'browser', 'default'],
    },
    build: {
        lib: {
            entry: 'src/main.ts',
            formats: ['es'],
            fileName: () => 'main.js',
            cssFileName: 'main',
        },
        cssCodeSplit: false,
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
        target: 'es2022',
        chunkSizeWarningLimit: 4000,
        rollupOptions: {
            output: {
                chunkFileNames: 'chunks/[name]-[hash].js',
            },
        },
    },
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    },
})
