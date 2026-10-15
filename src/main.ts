/**
 * Excalidraw drawings in EtherPK documents, kept as data in the document.
 *
 * A drawing is an Extension Fence (` ```excalidraw.drawing `, `format.ts`): EtherPK never searches its
 * lines, never shows them unless asked, and never publishes them as text. Through the EtherPK
 * Extension API the extension adds:
 *
 * - a widget over each drawing fence (`context.editor.registerFence`), a picture that turns into a
 *   live Excalidraw editor when clicked, on a desktop (`widget.ts`), saving as the person draws;
 * - Open in tab and Full window, where the Client draws the same widget bigger (the fence's
 *   `identify` lets the Client find the drawing again by its own id);
 * - `/drawing`, on a desktop, which puts a new drawing at the caret (`context.editor.insertBlock`);
 * - pasted on a line of its own, an excalidraw.com share link becomes a drawing to import, and shapes
 *   copied on excalidraw.com become a drawing of them (the fence's `fromPaste`, `share-link.ts`);
 * - on a published site, a picture of the drawing (the fence's `publish`);
 * - where a reference quotes the drawing, in the Backlinks panel and beneath a document, the same
 *   picture in the app's theme (the fence's `quote`).
 *
 * It mounts in the page rather than in a shadow root (`"isolation": "page"` in package.json), since
 * Excalidraw's copy and paste and its dialogs do not work inside one. Its stylesheet is scoped under
 * `.excalidraw` classes at build time (vite.config.ts), which the Client checks.
 */
import '@excalidraw/excalidraw/index.css'
import './styles.css'

import type { ExtensionContext, PublishedFence } from '@appsoftwareltd/etherpk-extension-api'

import { DRAWING_FENCE, drawingAlt, identifyDrawing, newDrawingText, readDrawing } from './format'
import { loadExcalidraw } from './load'
import { pastedDrawing } from './share-link'
import { createDrawingWidget, imagesLeftOut } from './widget'

/** Where this bundle is served from: Excalidraw's fonts are copied under it, at `fonts/`. */
const ASSET_BASE = new URL('./', import.meta.url).href

export const INSERT_COMMAND = 'excalidraw.insert'

/**
 * A drawing as a picture file, for a published site (light) and for a quote of it (in the app's
 * theme), or null for a drawing with nothing in it.
 */
async function drawingPicture(body: readonly string[], options: { dark: boolean }): Promise<PublishedFence | null> {
    const drawing = readDrawing(body)
    if (drawing.elements.length === 0 && drawing.skeletons.length === 0) return null
    const [{ drawingFile }, { convertSkeletons }] = await Promise.all([import('./picture'), import('./scene')])
    const kit = await loadExcalidraw(ASSET_BASE)
    // Shapes written by hand are drawn too, converted as the document would convert them.
    const elements = [...drawing.elements, ...convertSkeletons(kit, drawing.skeletons).elements]
    const file = await drawingFile(kit, { header: drawing.header, elements }, options)
    return { kind: 'picture', type: 'image/svg+xml', bytes: file.bytes, width: file.width, height: file.height, alt: drawingAlt(elements) }
}

export function activate(context: ExtensionContext): void {
    const widget = createDrawingWidget({ assetBase: ASSET_BASE, isDesktop: () => context.layout.isDesktop(), notify: (message) => context.notify(message) })
    context.editor.registerFence(DRAWING_FENCE, widget, {
        title: 'Drawing',
        keepsHistory: true,
        identify: identifyDrawing,
        fromPaste(text) {
            const pasted = pastedDrawing(text)
            if (!pasted) return null
            if (pasted.skippedImages > 0) context.notify(imagesLeftOut(pasted.skippedImages, 'pasted'))
            return pasted.lines
        },
        publish: (fence) => drawingPicture(fence.body, { dark: false }),
        quote: (fence) => drawingPicture(fence.body, { dark: fence.dark }),
    })

    context.commands.register(INSERT_COMMAND, () => {
        if (!context.layout.isDesktop()) return
        if (!context.editor.insertBlock(newDrawingText(), { focus: true })) {
            context.notify("The drawing couldn't go there. Put the caret on a line of its own and try again.")
        }
    })

    context.commandMenu.register({
        id: INSERT_COMMAND,
        title: 'Drawing',
        detail: 'Insert an Excalidraw drawing',
        icon: 'drawing',
        group: 'Insert',
        // After Map (115) and Video (116).
        order: 117,
        keywords: ['excalidraw', 'draw', 'sketch', 'diagram', 'whiteboard', 'canvas'],
        // Drawings are edited on a desktop only, and never in a Protected Document, which draws none.
        when: (menu) => menu.bodyWritable && !menu.inTable && !menu.protectedDocument && context.layout.isDesktop(),
        command: INSERT_COMMAND,
    })
}
