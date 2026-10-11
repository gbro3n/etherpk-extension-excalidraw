/**
 * A drawing in a document: what the extension draws over each ` ```excalidraw.drawing ` fence.
 *
 * - **In the document**, a drawing is a picture until it is clicked (or Enter is pressed on it), and
 *   then a live editor in its place, with Done, Full window and Open in tab above it. Only one drawing
 *   is live at a time: starting another puts the first back to its picture, saved. Done, or a press
 *   anywhere outside the drawing, puts it back too.
 * - **In a tab or over the window** (the Client hosts the same widget there), it is a live editor
 *   filling the space.
 * - **On a phone**, or where the document cannot be written, it is only ever a picture. A tap opens
 *   it over the whole window, where it can be zoomed.
 *
 * The picture is Excalidraw's own SVG export (`picture.ts`). Everything is built with the DOM and
 * React, never written as HTML.
 */
import type { FenceContext, FenceInfo, FenceWidget, MountedFence } from '@appsoftwareltd/etherpk-extension-api'

import { mountLiveEditor, type LiveEditor } from './editor'
import { drawingAlt, drawingBounds, readDrawing } from './format'
import { type ExcalidrawKit, loadExcalidraw } from './load'
import { drawingSvg } from './picture'

export interface DrawingServices {
    /** Where this bundle is served from: Excalidraw's fonts are under it. */
    assetBase: string
    /** True while the desktop presenter shows, where drawings are edited. */
    isDesktop(): boolean
}

const TOOLBAR_HEIGHT = 44
const EDITOR_HEIGHT = 520
const PICTURE_MIN = 120
const PICTURE_MAX = 480
const EMPTY_HEIGHT = 120
const PADDING = 32

/** The document column's width, as last measured by any drawing in it, for heights asked before one is drawn. */
let column = 680
/** The drawings being edited in their documents, by id: they are as tall as the editor. */
const editing = new Set<string>()
/** The one drawing live in a document now, put back to its picture when another starts. */
let live: { stop(): void } | null = null

function idOf(info: Pick<FenceInfo, 'body'>): string {
    return readDrawing(info.body.slice(0, 1)).header?.id ?? ''
}

/** A drawing's height in the document: the editor's while it is live, else its picture's at the column's width. */
export function drawingHeight(info: Pick<FenceInfo, 'body'>, width = column): number {
    if (editing.has(idOf(info))) return TOOLBAR_HEIGHT + EDITOR_HEIGHT
    const bounds = drawingBounds(readDrawing(info.body).elements)
    if (!bounds) return EMPTY_HEIGHT
    const scale = Math.min(1, (width - PADDING) / (bounds.width + PADDING))
    return Math.round(Math.min(PICTURE_MAX, Math.max(PICTURE_MIN, (bounds.height + PADDING) * scale)))
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

function button(className: string, text: string, onClick: () => void, testId?: string): HTMLButtonElement {
    const node = element('button', className, text)
    node.type = 'button'
    if (testId) node.dataset.testid = testId
    node.addEventListener('click', onClick)
    return node
}

export function createDrawingWidget(services: DrawingServices): FenceWidget {
    return {
        height: (info) => drawingHeight(info),
        mount(host, initial): MountedFence {
            let context = initial
            let editor: LiveEditor | null = null
            let destroyed = false
            /** Bumped by each draw, so a picture arriving for an earlier one is dropped. */
            let drawn = 0
            const root = element('div', 'excalidraw-drawing')
            root.dataset.presentation = context.presentation
            host.append(root)

            const editable = () => context.writable && services.isDesktop()
            const fills = () => context.presentation !== 'inline'

            const kit = () => loadExcalidraw(services.assetBase)

            const showPicture = async (target: HTMLElement, zoomable: boolean) => {
                const ticket = ++drawn
                const drawing = readDrawing(context.body)
                if (drawing.elements.length === 0) {
                    target.replaceChildren(element('p', 'excalidraw-drawing-empty', editable() ? 'An empty drawing. Click to draw.' : 'An empty drawing.'))
                    return
                }
                target.setAttribute('aria-busy', 'true')
                try {
                    const svg = await drawingSvg(await kit(), drawing, { dark: context.dark })
                    if (ticket !== drawn || destroyed) return
                    svg.classList.add('excalidraw-drawing-svg')
                    svg.setAttribute('role', 'img')
                    svg.setAttribute('aria-label', drawingAlt(drawing.elements))
                    if (zoomable) svg.classList.add('excalidraw-drawing-svg--zoomable')
                    target.replaceChildren(svg)
                } catch (error) {
                    console.error('[excalidraw] the picture could not be drawn', error)
                    if (ticket === drawn) target.replaceChildren(element('p', 'excalidraw-drawing-empty', "This drawing couldn't be shown."))
                } finally {
                    target.removeAttribute('aria-busy')
                }
            }

            /** The drawing as its picture: in the document, or filling a phone's window. */
            const drawPicture = () => {
                editor?.destroy()
                editor = null
                root.replaceChildren()
                root.classList.remove('excalidraw-drawing--live')
                if (fills()) {
                    // A tab or the window on a phone: the picture, which pinch zoom enlarges.
                    const frame = element('div', 'excalidraw-drawing-zoom')
                    root.append(frame)
                    void showPicture(frame, true)
                    return
                }
                const picture = element('button', 'excalidraw-drawing-picture')
                picture.type = 'button'
                picture.dataset.testid = 'excalidraw-picture'
                picture.setAttribute('aria-label', editable() ? 'Drawing. Press to edit it.' : 'Drawing. Press to see it bigger.')
                picture.addEventListener('click', () => (editable() ? startEditing(true) : context.openWindow()))
                root.append(picture)
                void showPicture(picture, false)
            }

            /** The drawing live: in its place in the document, or filling a tab or the window. */
            const startEditing = (focus: boolean) => {
                if (!editable()) return
                const id = idOf(context)
                if (!fills()) {
                    if (live && live.stop !== stopEditing) live.stop()
                    live = { stop: stopEditing }
                    editing.add(id)
                    context.resized()
                }
                root.replaceChildren()
                root.classList.add('excalidraw-drawing--live')
                if (!fills()) {
                    const toolbar = element('div', 'excalidraw-drawing-toolbar')
                    toolbar.append(
                        button('excalidraw-drawing-action', 'Done', () => stopEditing(), 'excalidraw-done'),
                        // The drawing goes on in the tab or the window, so here it goes back to its
                        // picture, saved: one live editor for a drawing, never two side by side.
                        button('excalidraw-drawing-action', 'Full window', () => {
                            stopEditing()
                            context.openWindow()
                        }, 'excalidraw-full-window'),
                        button('excalidraw-drawing-action', 'Open in tab', () => {
                            stopEditing()
                            context.openInTab()
                        }, 'excalidraw-open-tab'),
                    )
                    root.append(toolbar)
                }
                const canvas = element('div', 'excalidraw-drawing-editor')
                canvas.dataset.testid = 'excalidraw-editor'
                root.append(canvas)
                const ticket = ++drawn
                kit().then(
                    (loaded: ExcalidrawKit) => {
                        if (ticket !== drawn || destroyed) return
                        editor = mountLiveEditor(loaded, canvas, context, { autoFocus: focus })
                    },
                    (error: unknown) => {
                        console.error('[excalidraw] the editor could not load', error)
                        if (ticket === drawn) canvas.replaceChildren(element('p', 'excalidraw-drawing-empty', "Excalidraw couldn't load. Check your connection, then try again."))
                    },
                )
            }

            /** Back to the picture, saved. */
            const stopEditing = () => {
                if (live?.stop === stopEditing || fills()) live = null
                editor?.flush()
                if (!fills() && editing.delete(idOf(context))) context.resized()
                if (fills()) return
                drawPicture()
            }

            // A press anywhere outside a drawing live in the document puts it back to its picture,
            // also while Excalidraw is still loading for it.
            const outside = (event: PointerEvent) => {
                if (fills() || !root.classList.contains('excalidraw-drawing--live')) return
                const path = event.composedPath()
                if (path.includes(root)) return
                // Excalidraw's own dialogs and menus sit outside the drawing, in the page's body.
                if (path.some((node) => node instanceof HTMLElement && /\bexcalidraw\b/.test(node.className))) return
                stopEditing()
            }
            document.addEventListener('pointerdown', outside, true)

            // The column's width, for the picture's height: a change measures every drawing again.
            const observer =
                typeof ResizeObserver === 'undefined' || fills()
                    ? null
                    : new ResizeObserver((entries) => {
                          const width = Math.round(entries[0]?.contentRect.width ?? 0)
                          if (width > 0 && Math.abs(width - column) >= 8) {
                              column = width
                              context.resized()
                          }
                      })
            observer?.observe(host)

            if (fills() && editable()) startEditing(true)
            else if (!fills() && editing.has(idOf(context)) && editable()) startEditing(false)
            else if (context.takeFocus() && editable()) startEditing(true)
            else drawPicture()

            return {
                update(next) {
                    const before = context
                    context = next
                    root.dataset.presentation = next.presentation
                    if (editor) {
                        if (!editable()) {
                            stopEditing()
                            return
                        }
                        editor.update(next)
                        return
                    }
                    const changed = before.dark !== next.dark || before.writable !== next.writable || before.body.length !== next.body.length || before.body.some((line, i) => line !== next.body[i])
                    if (changed) drawPicture()
                },
                destroy() {
                    destroyed = true
                    document.removeEventListener('pointerdown', outside, true)
                    observer?.disconnect()
                    if (live?.stop === stopEditing) live = null
                    editor?.destroy()
                    editor = null
                    root.remove()
                },
            }
        },
    }
}
