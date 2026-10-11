/**
 * A picture of a drawing: Excalidraw's own SVG export, with the fonts its text uses embedded whole
 * (the build makes Excalidraw embed them whole rather than shrink them, see vite.config.ts), so the
 * picture stands on its own: in the document, on a phone, and as a file of a published site.
 */
import type { Drawing } from './format'
import type { ExcalidrawKit } from './load'

/** Kept pictures, by what they show, so a drawing scrolled back into view is not exported again. */
const kept = new Map<string, Promise<SVGSVGElement>>()
const KEEP = 24

export function drawingSvg(kit: ExcalidrawKit, drawing: Drawing, options: { dark: boolean }): Promise<SVGSVGElement> {
    const key = `${options.dark ? 'dark' : 'light'}\n${drawing.header?.background ?? ''}\n${JSON.stringify(drawing.elements)}`
    let picture: Promise<SVGSVGElement> | undefined = kept.get(key)
    if (!picture) {
        const elements = kit.excalidraw.restoreElements(drawing.elements as never, null)
        const exported: Promise<SVGSVGElement> = kit.excalidraw.exportToSvg({
            elements: elements as never,
            appState: {
                viewBackgroundColor: drawing.header?.background ?? '#ffffff',
                exportBackground: true,
                exportWithDarkMode: options.dark,
                exportEmbedScene: false,
            },
            files: null,
            exportPadding: 16,
        })
        exported.catch(() => kept.delete(key))
        kept.set(key, exported)
        if (kept.size > KEEP) kept.delete(kept.keys().next().value as string)
        picture = exported
    }
    // Each caller gets its own copy: one element cannot sit in two places in the page.
    return picture.then((svg) => svg.cloneNode(true) as SVGSVGElement)
}

/** The picture as a file for a published site: its bytes, size and type. */
export async function drawingFile(kit: ExcalidrawKit, drawing: Drawing): Promise<{ bytes: Uint8Array; width: number; height: number }> {
    const svg = await drawingSvg(kit, drawing, { dark: false })
    const width = Math.round(Number.parseFloat(svg.getAttribute('width') ?? '0')) || 640
    const height = Math.round(Number.parseFloat(svg.getAttribute('height') ?? '0')) || 360
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const text = new XMLSerializer().serializeToString(svg)
    return { bytes: new TextEncoder().encode(text), width, height }
}
