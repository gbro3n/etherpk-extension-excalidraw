/**
 * Excalidraw and React, loaded the first time a drawing is drawn, so a document with none never
 * downloads them. Excalidraw is told to take its fonts from beside this bundle
 * (`window.EXCALIDRAW_ASSET_PATH`), before it is loaded, which is when it reads that.
 */
import type * as ExcalidrawModule from '@excalidraw/excalidraw'
import type * as ReactModule from 'react'
import type * as ReactDomClient from 'react-dom/client'

export interface ExcalidrawKit {
    excalidraw: typeof ExcalidrawModule
    react: typeof ReactModule
    createRoot: typeof ReactDomClient.createRoot
}

let kit: Promise<ExcalidrawKit> | null = null

export function loadExcalidraw(assetBase: string): Promise<ExcalidrawKit> {
    kit ??= (async () => {
        ;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = assetBase
        const [excalidraw, react, client] = await Promise.all([import('@excalidraw/excalidraw'), import('react'), import('react-dom/client')])
        return { excalidraw, react, createRoot: client.createRoot }
    })()
    // A failed load is not kept, so the next drawing tries again.
    kit.catch(() => {
        kit = null
    })
    return kit
}
