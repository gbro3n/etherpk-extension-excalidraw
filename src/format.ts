/**
 * How a drawing is written in its document: an Extension Fence (` ```excalidraw.drawing `) whose first
 * line is the drawing's own id and settings, followed by one line of JSON per Excalidraw element.
 *
 * ````markdown
 * ```excalidraw.drawing
 * {"type":"excalidraw.drawing","version":1,"id":"k3j9x2q8ab","background":"#ffffff"}
 * {"id":"b1","type":"rectangle","x":10,"y":20,"width":120,"height":60,"version":4,"versionNonce":881,"index":"a0",…}
 * {"id":"t1","type":"text","text":"Raised beds","version":2,"versionNonce":17,"index":"a1",…}
 * ```
 * ````
 *
 * One element per line is what lets two devices edit one drawing: a change to an element replaces its
 * line, whole, with its line break, so two devices changing different elements change different lines,
 * and two changing the same element leave two lines for it, of which the reader keeps the later version
 * (Excalidraw's own rule: the higher `version`, then the lower `versionNonce`). The next save writes one
 * line again. A deleted element's line is removed. Elements are kept in any order and drawn in their
 * own stacking order (`index`).
 *
 * A line holding two elements, as a merge of two older edits could leave, is read as both. Pure, so
 * every rule here is tested in Node.
 */
import type { FenceEdit } from '@appsoftwareltd/etherpk-extension-api'

export const DRAWING_FENCE = 'excalidraw.drawing'
const HEADER_TYPE = 'excalidraw.drawing' as const

/** The drawing's first line. */
export interface DrawingHeader {
    type: typeof HEADER_TYPE
    version: 1
    /** The drawing's own id, which a tab and the full window find it by. */
    id: string
    /** The canvas colour. */
    background?: string
}

/** An Excalidraw element as the drawing keeps it: whatever Excalidraw wrote, with the fields merging reads. */
export interface ElementRecord {
    id: string
    version: number
    versionNonce: number
    index?: string | null
    isDeleted?: boolean
    [field: string]: unknown
}

export interface Drawing {
    header: DrawingHeader | null
    /** Each element once, the later version where a line held it twice, in stacking order. */
    elements: ElementRecord[]
}

/** A new drawing's id: ten letters and digits. */
export function newDrawingId(random: () => number = Math.random): string {
    let id = ''
    while (id.length < 10) id += Math.floor(random() * 36).toString(36)
    return id
}

export function headerLine(header: DrawingHeader): string {
    return JSON.stringify({ type: header.type, version: header.version, id: header.id, ...(header.background ? { background: header.background } : {}) })
}

/** The text `/drawing` puts in a document: a fence holding a new, empty drawing. */
export function newDrawingText(id: string = newDrawingId()): string {
    return ['```' + DRAWING_FENCE, headerLine({ type: HEADER_TYPE, version: 1, id, background: '#ffffff' }), '```'].join('\n')
}

/** Every JSON object written on one line, in order: one, or several where a merge joined lines. */
export function objectsOnLine(line: string): unknown[] {
    const out: unknown[] = []
    let depth = 0
    let start = -1
    let inString = false
    let escaped = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inString) {
            if (escaped) escaped = false
            else if (ch === '\\') escaped = true
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') {
            if (depth === 0) start = i
            depth++
        } else if (ch === '}' && depth > 0) {
            depth--
            if (depth === 0 && start !== -1) {
                try {
                    out.push(JSON.parse(line.slice(start, i + 1)))
                } catch {
                    // A broken object is skipped: the rest of the drawing still reads.
                }
                start = -1
            }
        }
    }
    return out
}

function isElement(value: unknown): value is ElementRecord {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return typeof record.id === 'string' && typeof record.type === 'string' && typeof record.version === 'number'
}

function isHeader(value: unknown): value is DrawingHeader {
    return !!value && typeof value === 'object' && (value as Record<string, unknown>).type === HEADER_TYPE && typeof (value as Record<string, unknown>).id === 'string'
}

/** Whether `a` is the later of two versions of one element, by Excalidraw's own rule. */
export function later(a: ElementRecord, b: ElementRecord): boolean {
    if (a.version !== b.version) return a.version > b.version
    return (a.versionNonce ?? 0) <= (b.versionNonce ?? 0)
}

/** Elements in their stacking order: by `index`, then by id, so every device draws them alike. */
export function byStackingOrder(elements: ElementRecord[]): ElementRecord[] {
    return elements.sort((a, b) => {
        const ai = a.index ?? ''
        const bi = b.index ?? ''
        if (ai !== bi) return ai < bi ? -1 : 1
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/** A drawing read from its fence's body. */
export function readDrawing(body: readonly string[]): Drawing {
    const first = body[0] ? objectsOnLine(body[0])[0] : undefined
    const header = isHeader(first) ? { type: HEADER_TYPE, version: 1 as const, id: first.id, ...(typeof first.background === 'string' ? { background: first.background } : {}) } : null
    const byId = new Map<string, ElementRecord>()
    body.forEach((line, n) => {
        if (n === 0 && header) return
        for (const value of objectsOnLine(line)) {
            if (!isElement(value) || value.isDeleted) continue
            const known = byId.get(value.id)
            if (!known || later(value, known)) byId.set(value.id, value)
        }
    })
    return { header, elements: byStackingOrder([...byId.values()]) }
}

/** The drawing's own id, which the Client finds a drawing by in a tab or the full window. */
export function identifyDrawing(body: readonly string[]): string | null {
    return readDrawing(body.slice(0, 1)).header?.id ?? null
}

/** An element as its line: compact JSON, no line breaks (JSON escapes them inside strings). */
export function elementLine(element: ElementRecord): string {
    return JSON.stringify(element)
}

/**
 * The edits that turn `body` into the drawing `next`: each element whose version changed replaces its
 * line, each deleted element's line goes, a second line for one element goes, each new element is
 * added at the end, and the first line follows the settings. Lines that already say what `next` holds
 * are left alone, so a save touches only what changed. Removals and replacements run from the last
 * line up, so each edit's line number holds when it is applied, and additions come after them.
 */
export function planWrite(body: readonly string[], next: { header: DrawingHeader; elements: readonly ElementRecord[] }): FenceEdit[] {
    const wanted = new Map(next.elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]))
    const written = new Set<string>()
    const edits: FenceEdit[] = []
    const headerAt = body.length > 0 && isHeader(objectsOnLine(body[0])[0]) ? 0 : -1
    for (let n = body.length - 1; n >= 0; n--) {
        if (n === headerAt) continue
        const line = body[n]
        const objects = objectsOnLine(line).filter(isElement)
        // A line is kept when it holds exactly one element that `next` holds at that very version.
        const only = objects.length === 1 ? objects[0] : null
        const target = only ? wanted.get(only.id) : undefined
        if (only && target && target.version === only.version && target.versionNonce === only.versionNonce && !written.has(only.id)) {
            written.add(only.id)
            continue
        }
        // Otherwise the line becomes the first of its elements `next` still holds and no line has yet.
        const keep = objects.map((object) => wanted.get(object.id)).find((element) => element && !written.has(element.id))
        if (keep) {
            written.add(keep.id)
            edits.push({ kind: 'replace', line: n, expect: line, text: elementLine(keep) })
        } else {
            edits.push({ kind: 'remove', line: n, expect: line })
        }
    }
    const header = headerLine(next.header)
    if (headerAt === 0) {
        if (body[0] !== header) edits.push({ kind: 'replace', line: 0, expect: body[0], text: header })
    } else {
        edits.push({ kind: 'insert', line: 0, text: header })
    }
    let length = body.length - edits.filter((edit) => edit.kind === 'remove').length + (headerAt === 0 ? 0 : 1)
    for (const element of next.elements) {
        if (element.isDeleted || written.has(element.id)) continue
        written.add(element.id)
        edits.push({ kind: 'insert', line: length++, text: elementLine(element) })
    }
    return edits
}

/**
 * Merge a drawing changed elsewhere into the one on screen, with the drawing as it was last read
 * (`base`) to tell an element deleted elsewhere from one added here. An element both sides hold is
 * the later version. One only the other side holds was added there. One only this side holds was
 * added here, unless `base` held it and this side has not changed it since, when it was deleted there.
 */
export function mergeDrawing(base: readonly ElementRecord[], local: readonly ElementRecord[], remote: readonly ElementRecord[]): ElementRecord[] {
    const baseById = new Map(base.map((element) => [element.id, element]))
    const remoteById = new Map(remote.map((element) => [element.id, element]))
    const out = new Map<string, ElementRecord>()
    for (const element of remote) out.set(element.id, element)
    for (const element of local) {
        if (element.isDeleted) continue
        const theirs = remoteById.get(element.id)
        if (theirs) {
            if (later(element, theirs)) out.set(element.id, element)
            continue
        }
        const before = baseById.get(element.id)
        // Deleted elsewhere, and not touched here since: it stays deleted.
        if (before && before.version === element.version) continue
        out.set(element.id, element)
    }
    return byStackingOrder([...out.values()])
}

/** A body after `edits`, applied in order as the Client applies them, or null when one no longer applies. */
export function applyEdits(body: readonly string[], edits: readonly FenceEdit[]): string[] | null {
    const next = [...body]
    for (const edit of edits) {
        if (edit.kind === 'insert') {
            if (edit.line < 0 || edit.line > next.length) return null
            next.splice(edit.line, 0, edit.text)
            continue
        }
        if (next[edit.line] !== edit.expect) return null
        if (edit.kind === 'replace') next[edit.line] = edit.text
        else next.splice(edit.line, 1)
    }
    return next
}

/** Whether two bodies are the same lines. */
export function sameBody(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((line, i) => line === b[i])
}

/** The space the elements take: their bounding box, or null for an empty drawing. */
export function drawingBounds(elements: readonly ElementRecord[]): { width: number; height: number } | null {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const element of elements) {
        const x = Number(element.x ?? 0)
        const y = Number(element.y ?? 0)
        const points = Array.isArray(element.points) ? (element.points as [number, number][]) : null
        const corners: [number, number][] = points
            ? points.map(([px, py]) => [x + Number(px), y + Number(py)])
            : [
                  [x, y],
                  [x + Number(element.width ?? 0), y + Number(element.height ?? 0)],
              ]
        for (const [cx, cy] of corners) {
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue
            minX = Math.min(minX, cx)
            minY = Math.min(minY, cy)
            maxX = Math.max(maxX, cx)
            maxY = Math.max(maxY, cy)
        }
    }
    if (!Number.isFinite(minX)) return null
    return { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }
}

/** What a picture of the drawing says to anyone who cannot see it: its words, or that it is a drawing. */
export function drawingAlt(elements: readonly ElementRecord[]): string {
    const words = elements
        .filter((element) => element.type === 'text' && typeof element.text === 'string')
        .map((element) => (element.text as string).replace(/\s+/g, ' ').trim())
        .filter((text) => text !== '')
    if (words.length === 0) return 'Drawing'
    const said = words.join(', ')
    return `Drawing: ${said.length > 200 ? `${said.slice(0, 197)}…` : said}`
}
