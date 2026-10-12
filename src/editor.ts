/**
 * A live Excalidraw editor over one drawing, saving as the person draws:
 *
 * - **What is written.** Only the lines of elements whose version changed, the lines of those the
 *   person deleted removed and new ones added (`planWrite`), as one change (`context.edit` with a
 *   list), at most every half second while drawing and at once when a stroke ends. The scene is read
 *   with its deleted elements, since a deletion is the only thing that removes a line: an element
 *   Excalidraw never loaded keeps its line.
 * - **Changes from elsewhere** (another device, another view of the drawing) arrive as a new body.
 *   They are merged into what is on screen with the drawing as last read (`mergeDrawing`), without
 *   disturbing the stroke in progress, and anything newer here is written back on the next save.
 * - **Undo.** Mod+Z and Mod+Y are Excalidraw's own while it has the keyboard: its fence is registered
 *   with `keepsHistory`.
 *
 * Excalidraw's features that reach other services are off: links to its site and social pages,
 * library publishing, web embeds and AI. Its image tool is off too, since a picture inside a drawing
 * would be written into every save of it.
 */
import type { FenceContext } from '@appsoftwareltd/etherpk-extension-api'

import { applyEdits, type DrawingHeader, type ElementRecord, mergeDrawing, newDrawingId, planWrite, readDrawing, sameBody } from './format'
import type { ExcalidrawKit } from './load'
import { restoreScene } from './scene'

/** How long a run of changes waits before it is written, while the person is still drawing. */
const SAVE_DELAY = 500

export interface LiveEditor {
    /** The fence changed (its body, the theme, whether it can be written). */
    update(context: FenceContext): void
    /** Write whatever is not yet written, now. */
    flush(): void
    destroy(): void
}

let instances = 0

export function mountLiveEditor(kit: ExcalidrawKit, element: HTMLElement, initial: FenceContext, options: { autoFocus: boolean }): LiveEditor {
    const { createElement } = kit.react
    const { Excalidraw, MainMenu, CaptureUpdateAction } = kit.excalidraw
    let context = initial
    /** The body as last read or written: the base a change from elsewhere is merged against. */
    let body: readonly string[] = context.body
    const read = readDrawing(body)
    let header: DrawingHeader = read.header ?? { type: 'excalidraw.drawing', version: 1, id: newDrawingId(), background: '#ffffff' }
    type Api = {
        getSceneElementsIncludingDeleted(): readonly unknown[]
        getAppState(): { viewBackgroundColor: string; editingTextElement?: { id: string } | null; newElement?: { id: string } | null }
        updateScene(scene: unknown): void
    }
    let api: Api | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    /** A version stamp of what is on screen when it was last written, so an unchanged scene is not compared line by line. */
    let writtenStamp = ''
    let destroyed = false

    const stampOf = (elements: readonly unknown[], background: string) => `${background}:${(elements as { id: string; version: number }[]).map((e) => `${e.id}.${e.version}`).join(',')}`

    function flush(): void {
        if (timer) clearTimeout(timer)
        timer = null
        if (!api || !context.writable) return
        const elements = api.getSceneElementsIncludingDeleted() as unknown as ElementRecord[]
        const background = api.getAppState().viewBackgroundColor
        const stamp = stampOf(elements, background)
        if (stamp === writtenStamp) return
        const next = { header: { ...header, background }, elements }
        const edits = planWrite(body, next)
        if (edits.length === 0) {
            writtenStamp = stamp
            return
        }
        const after = applyEdits(body, edits)
        // Refused: the body changed meanwhile. Its new text arrives in an update, merged, then saved.
        if (!after || !context.edit(edits)) return
        body = after
        header = next.header
        writtenStamp = stamp
    }

    const schedule = () => {
        if (destroyed || !context.writable) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(flush, SAVE_DELAY)
    }

    const root = kit.createRoot(element, { identifierPrefix: `etherpk-excalidraw-${++instances}` })
    const render = () => {
        root.render(
            createElement(
                Excalidraw,
                {
                    initialData: {
                        elements: restoreScene(kit, read.elements),
                        appState: { viewBackgroundColor: header.background ?? '#ffffff' },
                        scrollToContent: true,
                    },
                    excalidrawAPI: (value: unknown) => {
                        api = value as Api
                    },
                    theme: context.dark ? 'dark' : 'light',
                    viewModeEnabled: !context.writable,
                    autoFocus: options.autoFocus,
                    handleKeyboardGlobally: false,
                    onChange: () => schedule(),
                    // A stroke ended: written at once, so a closed tab never loses it.
                    onPointerUp: () => queueMicrotask(flush),
                    UIOptions: {
                        canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: false, export: false, toggleTheme: false, changeViewBackgroundColor: true, clearCanvas: true },
                        tools: { image: false },
                    },
                    validateEmbeddable: false,
                    aiEnabled: false,
                    // Library browsing returns here: the Client's origin, never a page's address, which holds the graph's id.
                    libraryReturnUrl: `${location.origin}/`,
                } as never,
                // Its menu with what works offline only: no links to its site, no social pages.
                createElement(MainMenu, null, createElement(MainMenu.DefaultItems.ChangeCanvasBackground), createElement(MainMenu.DefaultItems.ClearCanvas)),
            ),
        )
    }
    render()

    return {
        update(next) {
            const themeChanged = next.dark !== context.dark || next.writable !== context.writable
            context = next
            if (themeChanged) render()
            if (sameBody(next.body, body) || !api) return
            // A change from elsewhere: merged with what is on screen, against the body as last read.
            const remote = readDrawing(next.body)
            const local = api.getSceneElementsIncludingDeleted() as unknown as ElementRecord[]
            // The text being typed and the shape being drawn stay as they are here (mergeDrawing).
            const state = api.getAppState()
            const inHand = new Set([state.editingTextElement?.id, state.newElement?.id].filter((id): id is string => typeof id === 'string'))
            const merged = mergeDrawing(readDrawing(body).elements, local, remote.elements, inHand)
            body = next.body
            if (remote.header) header = remote.header
            api.updateScene({ elements: restoreScene(kit, merged), captureUpdate: CaptureUpdateAction.NEVER })
            // Whatever is newer here is written on the next save.
            writtenStamp = ''
            schedule()
        },
        flush,
        destroy() {
            flush()
            destroyed = true
            if (timer) clearTimeout(timer)
            // Unmounted after the widget's element left: React must not unmount inside the editor's own update.
            queueMicrotask(() => root.unmount())
        },
    }
}
