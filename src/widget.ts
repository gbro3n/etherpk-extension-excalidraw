/**
 * A drawing in a document: what the extension draws over each ` ```excalidraw.drawing ` fence.
 *
 * - **In the document**, a drawing is a picture until it is clicked (or Enter is pressed on it), and
 *   then a live editor in its place, with Done, Full window, Open in tab, Edit as text and Delete above
 *   it. Only one drawing is live at a time: starting another puts the first back to its picture,
 *   saved. Done, or a press anywhere outside the drawing, puts it back too. The picture has a menu of
 *   its own with Edit as text and Delete.
 * - **In a tab or over the window** (the Client hosts the same widget there), it is a live editor
 *   filling the space.
 * - **On a phone**, or where the document cannot be written, it is only ever a picture. A tap opens
 *   it over the whole window, where it can be zoomed.
 * - **A share link from excalidraw.com** in the drawing is a card offering to import it
 *   (`share-link.ts`). Nothing is fetched until the person presses it.
 * - **Shapes written by hand** (skeletons, `format.ts`) are converted once Excalidraw has loaded and,
 *   where the document can be written, written back as full elements (`scene.ts`).
 *
 * Delete removes the drawing as one change and says that Mod+Z brings it back, rather than asking
 * first. The picture is Excalidraw's own SVG export (`picture.ts`). Everything is built with the DOM
 * and React, never written as HTML. The buttons, the menu and the link carry the Client's control
 * classes (`gk-button`, `gk-icon-button`, `gk-menu`, `gk-link`), so they are drawn as EtherPK's own.
 */
import type { FenceContext, FenceInfo, FenceWidget, MountedFence } from '@appsoftwareltd/etherpk-extension-api'

import { mountLiveEditor, type LiveEditor } from './editor'
import { type Drawing, drawingAlt, drawingBounds, planSkeletonWrite, readDrawing } from './format'
import { type ExcalidrawKit, loadExcalidraw } from './load'
import { drawingSvg } from './picture'
import { convertSkeletons, skeletonKey } from './scene'
import { fetchSharedDrawing, ImportError, planImport, shareLinkIn } from './share-link'

export interface DrawingServices {
    /** Where this bundle is served from: Excalidraw's fonts are under it. */
    assetBase: string
    /** True while the desktop presenter shows, where drawings are edited. */
    isDesktop(): boolean
    /** Tell the person something the page does not show, such as how to undo a delete. */
    notify(message: string): void
}

const TOOLBAR_HEIGHT = 44
const EDITOR_HEIGHT = 520
const PICTURE_MIN = 120
const PICTURE_MAX = 480
const EMPTY_HEIGHT = 120
const IMPORT_HEIGHT = 148
const PADDING = 32
/** How long an import runs before its button says so, so a quick one does not flash. */
const BUSY_DELAY = 200

/** The document column's width, as last measured by any drawing in it, for heights asked before one is drawn. */
let column = 680
/** The drawings being edited in their documents, by id: they are as tall as the editor. */
const editing = new Set<string>()
/** The one drawing live in a document now, put back to its picture when another starts. */
let live: { stop(): void } | null = null
/** Numbers for the ids that tie a menu to its button and a card to its title. */
let ids = 0

function idOf(info: Pick<FenceInfo, 'body'>): string {
    return readDrawing(info.body.slice(0, 1)).header?.id ?? ''
}

/** A drawing's height in the document: the editor's while it is live, an import card's, else its picture's at the column's width. */
export function drawingHeight(info: Pick<FenceInfo, 'body'>, width = column): number {
    if (shareLinkIn(info.body)) return IMPORT_HEIGHT
    if (editing.has(idOf(info))) return TOOLBAR_HEIGHT + EDITOR_HEIGHT
    // Shapes written by hand count too: they are drawn once converted.
    const drawing = readDrawing(info.body)
    const bounds = drawingBounds([...drawing.elements, ...drawing.skeletons])
    if (!bounds) return EMPTY_HEIGHT
    const scale = Math.min(1, (width - PADDING) / (bounds.width + PADDING))
    return Math.round(Math.min(PICTURE_MAX, Math.max(PICTURE_MIN, (bounds.height + PADDING) * scale)))
}

/** What the person is told when images were left out of a drawing brought in from excalidraw.com. */
export function imagesLeftOut(count: number, how: 'pasted' | 'imported'): string {
    return `The drawing was ${how} without its ${count === 1 ? 'image' : `${count} images`}. Drawings in EtherPK hold no images.`
}

const DELETED = 'Drawing deleted. Press Ctrl+Z (Cmd+Z on a Mac) in the document to bring it back.'

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

/** Three dots in a row, for the menu's button. */
function moreIcon(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', 'excalidraw-drawing-menu-icon')
    for (const cx of [3.5, 8, 12.5]) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        dot.setAttribute('cx', String(cx))
        dot.setAttribute('cy', '8')
        dot.setAttribute('r', '1.5')
        svg.append(dot)
    }
    return svg
}

/**
 * A menu button and its menu, with the keyboard a menu has: arrows move between the items, Escape
 * closes it and gives the button back the focus, Tab closes it. Returns the element and a way to close it.
 * An item that removes something (`danger`) is drawn in the danger colour, as the toolbar's Delete is.
 */
function actionMenu(label: string, items: readonly { text: string; testId: string; danger?: boolean; run(): void }[]): { root: HTMLElement; close(): void; contains(node: Node): boolean } {
    const root = element('div', 'excalidraw-drawing-menu')
    const trigger = element('button', 'gk-icon-button gk-button--raised excalidraw-drawing-menu-button')
    trigger.type = 'button'
    trigger.dataset.testid = 'excalidraw-menu'
    trigger.setAttribute('aria-label', label)
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.append(moreIcon())
    const list = element('div', 'gk-menu excalidraw-drawing-menu-list')
    list.id = `excalidraw-drawing-menu-${++ids}`
    list.setAttribute('role', 'menu')
    list.setAttribute('aria-label', label)
    list.hidden = true
    trigger.setAttribute('aria-controls', list.id)
    const entries = items.map((item) => {
        const entry = button(item.danger ? 'gk-menu-item gk-menu-item--danger' : 'gk-menu-item', item.text, () => {
            close(false)
            item.run()
        }, item.testId)
        entry.setAttribute('role', 'menuitem')
        entry.tabIndex = -1
        return entry
    })
    list.append(...entries)
    root.append(trigger, list)

    const open = (focusAt: number) => {
        list.hidden = false
        trigger.setAttribute('aria-expanded', 'true')
        entries[(focusAt + entries.length) % entries.length]?.focus()
    }
    function close(restoreFocus: boolean) {
        if (list.hidden) return
        list.hidden = true
        trigger.setAttribute('aria-expanded', 'false')
        if (restoreFocus) trigger.focus()
    }
    trigger.addEventListener('click', () => (list.hidden ? open(0) : close(true)))
    trigger.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        open(event.key === 'ArrowDown' ? 0 : -1)
    })
    list.addEventListener('keydown', (event) => {
        const at = entries.indexOf(document.activeElement as HTMLButtonElement)
        const step: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: entries.length - 1 }
        if (event.key in step) {
            event.preventDefault()
            entries[(step[event.key] + entries.length) % entries.length].focus()
        } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close(true)
        } else if (event.key === 'Tab') {
            close(false)
        }
    })
    return { root, close: () => close(false), contains: (node) => root.contains(node) }
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
            /** The menu drawn over the picture or the import card, while there is one. */
            let menu: ReturnType<typeof actionMenu> | null = null
            const root = element('div', 'excalidraw-drawing')
            root.dataset.presentation = context.presentation
            host.append(root)

            const editable = () => context.writable && services.isDesktop()
            const fills = () => context.presentation !== 'inline'

            const kit = () => loadExcalidraw(services.assetBase)

            /** Delete the drawing, as one change Mod+Z gives back. */
            const deleteDrawing = () => {
                if (context.remove()) services.notify(DELETED)
            }

            /** Edit as text and Delete, over the picture or the card, where the document can be written. */
            const addMenu = () => {
                menu = null
                if (!context.writable || fills()) return
                menu = actionMenu('Drawing actions', [
                    { text: 'Edit as text', testId: 'excalidraw-edit-text', run: () => context.editAsText() },
                    { text: 'Delete', testId: 'excalidraw-delete', danger: true, run: deleteDrawing },
                ])
                root.append(menu.root)
            }

            /**
             * The drawing to show, with any shapes written by hand converted. Where the document can be
             * written, the conversions are written back in their place; the new body arrives in an
             * update, which draws again from full elements.
             */
            const converted = (loaded: ExcalidrawKit, drawing: Drawing): Pick<Drawing, 'header' | 'elements'> => {
                if (drawing.skeletons.length === 0) return drawing
                const conversion = convertSkeletons(loaded, drawing.skeletons)
                if (context.writable && conversion.converted.size > 0) {
                    const edits = planSkeletonWrite(context.body, (skeleton) => conversion.converted.has(skeletonKey(skeleton)), conversion.elements)
                    // Only together with taking the skeletons out, so a write can never add the elements twice.
                    if (edits.some((edit) => edit.kind !== 'insert')) context.edit(edits)
                }
                return { header: drawing.header, elements: [...drawing.elements, ...conversion.elements] }
            }

            const showPicture = async (target: HTMLElement, zoomable: boolean) => {
                const ticket = ++drawn
                const drawing = readDrawing(context.body)
                if (drawing.elements.length === 0 && drawing.skeletons.length === 0) {
                    target.replaceChildren(element('p', 'excalidraw-drawing-empty', editable() ? 'An empty drawing. Click to draw.' : 'An empty drawing.'))
                    return
                }
                target.setAttribute('aria-busy', 'true')
                try {
                    const loaded = await kit()
                    if (ticket !== drawn || destroyed) return
                    const shown = converted(loaded, drawing)
                    const svg = await drawingSvg(loaded, shown, { dark: context.dark })
                    if (ticket !== drawn || destroyed) return
                    svg.classList.add('excalidraw-drawing-svg')
                    svg.setAttribute('role', 'img')
                    svg.setAttribute('aria-label', drawingAlt(shown.elements))
                    if (zoomable) svg.classList.add('excalidraw-drawing-svg--zoomable')
                    target.replaceChildren(svg)
                } catch (error) {
                    console.error('[excalidraw] the picture could not be drawn', error)
                    if (ticket === drawn) target.replaceChildren(element('p', 'excalidraw-drawing-empty', "This drawing couldn't be shown."))
                } finally {
                    target.removeAttribute('aria-busy')
                }
            }

            /** A share link in the drawing: a card that imports it when pressed. */
            const drawImportCard = () => {
                const found = shareLinkIn(context.body)
                if (!found) return
                const card = element('div', 'excalidraw-drawing-import')
                card.dataset.testid = 'excalidraw-import'
                const title = element('p', 'excalidraw-drawing-import-title', 'A drawing shared from excalidraw.com')
                title.id = `excalidraw-drawing-import-${++ids}`
                card.setAttribute('role', 'group')
                card.setAttribute('aria-labelledby', title.id)
                const status = element('p', 'excalidraw-drawing-import-note')
                status.setAttribute('role', 'status')
                const actions = element('div', 'excalidraw-drawing-import-actions')
                const open = element('a', 'gk-link', 'Open on excalidraw.com')
                open.href = found.link
                open.target = '_blank'
                open.rel = 'noopener noreferrer'
                if (context.writable) {
                    status.textContent = 'Pressing import fetches the drawing from excalidraw.com and writes it into this document.'
                    const label = 'Import this drawing from excalidraw.com'
                    let importing = false
                    const run = button('gk-button gk-button--primary', label, () => {
                        if (importing) return
                        importing = true
                        run.setAttribute('aria-busy', 'true')
                        const busy = setTimeout(() => {
                            run.textContent = 'Importing…'
                        }, BUSY_DELAY)
                        const settle = () => {
                            clearTimeout(busy)
                            importing = false
                            run.removeAttribute('aria-busy')
                            run.textContent = label
                        }
                        fetchSharedDrawing(found).then(
                            (shared) => {
                                settle()
                                if (destroyed) return
                                if (!context.edit(planImport(context.body, shared))) {
                                    status.textContent = 'The drawing changed while it was fetched. Press import again.'
                                    return
                                }
                                if (shared.skippedImages > 0) services.notify(imagesLeftOut(shared.skippedImages, 'imported'))
                            },
                            (error: unknown) => {
                                settle()
                                if (destroyed) return
                                status.textContent = error instanceof ImportError ? error.message : "The drawing couldn't be imported. Try again."
                                if (!(error instanceof ImportError)) console.error('[excalidraw] the import failed', error)
                            },
                        )
                    }, 'excalidraw-import-button')
                    actions.append(run)
                } else {
                    status.textContent = 'Open this document where it can be edited to import the drawing.'
                }
                actions.append(open)
                card.append(title, status, actions)
                root.append(card)
            }

            /** The drawing as its picture: in the document, or filling a phone's window. */
            const drawPicture = () => {
                editor?.destroy()
                editor = null
                drawn++
                root.replaceChildren()
                root.classList.remove('excalidraw-drawing--live')
                if (shareLinkIn(context.body)) {
                    drawImportCard()
                    addMenu()
                    return
                }
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
                addMenu()
                void showPicture(picture, false)
            }

            /** The drawing live: in its place in the document, or filling a tab or the window. */
            const startEditing = (focus: boolean) => {
                if (!editable() || shareLinkIn(context.body)) return
                const id = idOf(context)
                if (!fills()) {
                    if (live && live.stop !== stopEditing) live.stop()
                    live = { stop: stopEditing }
                    editing.add(id)
                    context.resized()
                }
                menu = null
                root.replaceChildren()
                root.classList.add('excalidraw-drawing--live')
                if (!fills()) {
                    const toolbar = element('div', 'excalidraw-drawing-toolbar')
                    const changes = element('div', 'excalidraw-drawing-toolbar-group')
                    changes.append(
                        // Saved and back to the picture first, so the text shown is what was drawn.
                        button('gk-button', 'Edit as text', () => {
                            stopEditing()
                            context.editAsText()
                        }, 'excalidraw-edit-text'),
                        button('gk-button gk-button--danger', 'Delete', () => {
                            // Saved first, so Mod+Z brings back the drawing as it was last drawn.
                            stopEditing()
                            deleteDrawing()
                        }, 'excalidraw-delete'),
                    )
                    toolbar.append(
                        button('gk-button', 'Done', () => stopEditing(), 'excalidraw-done'),
                        // The drawing goes on in the tab or the window, so here it goes back to its
                        // picture, saved: one live editor for a drawing, never two side by side.
                        button('gk-button', 'Full window', () => {
                            stopEditing()
                            context.openWindow()
                        }, 'excalidraw-full-window'),
                        button('gk-button', 'Open in tab', () => {
                            stopEditing()
                            context.openInTab()
                        }, 'excalidraw-open-tab'),
                        changes,
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
                        // Shapes written by hand are written back first; they reach the editor in the update that follows.
                        converted(loaded, readDrawing(context.body))
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
            // also while Excalidraw is still loading for it. A press outside its menu closes that.
            const outside = (event: PointerEvent) => {
                const path = event.composedPath()
                if (menu && !path.some((node) => node instanceof Node && menu?.contains(node))) menu.close()
                if (fills() || !root.classList.contains('excalidraw-drawing--live')) return
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

            if (fills() && editable() && !shareLinkIn(context.body)) startEditing(true)
            else if (!fills() && editing.has(idOf(context)) && editable()) startEditing(false)
            else if (context.takeFocus() && editable() && !shareLinkIn(context.body)) startEditing(true)
            else drawPicture()

            return {
                update(next) {
                    const before = context
                    context = next
                    root.dataset.presentation = next.presentation
                    if (root.classList.contains('excalidraw-drawing--live')) {
                        // Live in the document and no longer editable: back to the picture. Otherwise
                        // the editor takes the change, or, still loading, mounts with it.
                        if (!fills() && !editable()) {
                            stopEditing()
                            return
                        }
                        editor?.update(next)
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
