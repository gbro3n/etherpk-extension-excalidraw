import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

import { expect, type Locator, type Page, test } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'

/**
 * Drawings in a running EtherPK Client: over its editor harness (`/dev/editor`), and in a graph in
 * the browser's private storage (OPFS) for what needs the workspace: a tab, the full window, a phone
 * and publishing. Nothing here reaches another service: Excalidraw's fonts and code are this
 * extension's own files, served by the Client.
 */

const header = (id: string) => JSON.stringify({ type: 'excalidraw.drawing', version: 1, id, background: '#ffffff' })
const rectangle = JSON.stringify({ id: 'r1', type: 'rectangle', version: 1, versionNonce: 1, x: 0, y: 0, width: 160, height: 80 })
// A text element as Excalidraw writes one, in its own hand-drawn font (Excalifont, family 5).
const label = JSON.stringify({
    id: 't1',
    type: 'text',
    version: 1,
    versionNonce: 2,
    x: 20,
    y: 20,
    width: 56,
    height: 25,
    text: 'Beans',
    originalText: 'Beans',
    fontSize: 20,
    fontFamily: 5,
    textAlign: 'left',
    verticalAlign: 'top',
    lineHeight: 1.25,
    containerId: null,
    autoResize: true,
})
const drawing = (id: string, ...elements: string[]) => ['```excalidraw.drawing', header(id), ...elements, '```'].join('\n')

async function openEditor(page: Page) {
    await page.goto('/dev/editor')
    await expect(page.getByTestId('document-editor').locator('.cm-editor')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('editor-index-ready')).toBeVisible({ timeout: 30_000 })
}

async function setDoc(page: Page, text: string) {
    await page.evaluate((value) => (window as unknown as { __setDoc(text: string): void }).__setDoc(value), text)
    await expect.poll(() => getDoc(page)).toBe(text)
}

function getDoc(page: Page): Promise<string> {
    return page.evaluate(() => (window as unknown as { __getDoc(): string }).__getDoc())
}

async function caretAt(page: Page, position: number) {
    await page.getByTestId('document-editor').locator('.cm-content').click()
    await page.evaluate((at) => (window as unknown as { __setCaret(at: number): void }).__setCaret(at), position)
}

async function paste(page: Page, text: string) {
    await page.getByTestId('document-editor').locator('.cm-content').evaluate((element, value) => {
        const data = new DataTransfer()
        data.setData('text/plain', value)
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)
}

/** The Client's notices, which the harness writes to the console rather than drawing. */
function notices(page: Page): string[] {
    const said: string[] = []
    page.on('console', (message) => said.push(message.text()))
    return said
}

/** The lines of the document's drawing, between its fences. */
async function drawingLines(page: Page): Promise<string[]> {
    const text = await getDoc(page)
    const start = text.indexOf('```excalidraw.drawing\n')
    if (start < 0) return []
    const body = text.slice(start + '```excalidraw.drawing\n'.length)
    return body.slice(0, body.indexOf('\n```')).split('\n')
}

/** A scene encrypted and joined as excalidraw.com stores a shared drawing, with the key its link carries. */
async function sharedScene(scene: unknown): Promise<{ bytes: Buffer; key: string }> {
    const join = (...buffers: Uint8Array[]) => {
        const out = new Uint8Array(4 + buffers.reduce((sum, buffer) => sum + 4 + buffer.byteLength, 0))
        const view = new DataView(out.buffer)
        view.setUint32(0, 1)
        let at = 4
        for (const buffer of buffers) {
            view.setUint32(at, buffer.byteLength)
            out.set(buffer, at + 4)
            at += 4 + buffer.byteLength
        }
        return out
    }
    const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, deflateSync(join(utf8(null), utf8(scene)))))
    const bytes = join(utf8({ version: 2, compression: 'pako@1', encryption: 'AES-GCM' }), iv, encrypted)
    return { bytes: Buffer.from(bytes), key: (await crypto.subtle.exportKey('jwk', key)).k! }
}

/**
 * Draw a rectangle on the live drawing in `within`: the R key, then a drag across the canvas, once
 * Excalidraw has loaded and holds the keyboard.
 */
async function drawRectangle(page: Page, within: Locator) {
    const editor = within.getByTestId('excalidraw-editor')
    await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    const canvas = (await editor.boundingBox())!
    await page.keyboard.press('r')
    await page.mouse.move(canvas.x + canvas.width / 2 - 100, canvas.y + canvas.height / 2 - 60)
    await page.mouse.down()
    await page.mouse.move(canvas.x + canvas.width / 2 + 100, canvas.y + canvas.height / 2 + 60, { steps: 8 })
    await page.mouse.up()
}

/** A graph in the browser's private storage, opened at `concept`. */
async function openGraph(page: Page, id: string, pages: Record<string, string>, concept: string) {
    await page.goto('/dev/filesystem')
    await page.evaluate(
        async ({ id, pages }) => {
            const root = await navigator.storage.getDirectory()
            await root.removeEntry(`graph-${id}`, { recursive: true }).catch(() => {})
            const graph = await root.getDirectoryHandle(`graph-${id}`, { create: true })
            for (const sub of ['journals', 'pages', 'assets', 'etherpk']) await graph.getDirectoryHandle(sub, { create: true })
            const folder = await graph.getDirectoryHandle('pages')
            for (const [name, text] of Object.entries(pages)) {
                const writable = await (await folder.getFileHandle(`${name}.md`, { create: true })).createWritable()
                await writable.write(text)
                await writable.close()
            }
        },
        { id, pages },
    )
    await page.goto(`/g/${id}/d/${encodeURIComponent(concept)}?fs=opfs&autosaveMs=150`)
    await expect(page.locator(`[data-doc-target="${concept}"] .cm-content`)).toBeVisible({ timeout: 30_000 })
}

test.describe('a drawing in a document', () => {
    test.beforeEach(async ({ page }) => {
        await openEditor(page)
    })

    test('/drawing puts an empty drawing at the caret, live, and what is drawn is saved as lines of the document', async ({ page }) => {
        await setDoc(page, 'Garden\n\nAfter')
        await caretAt(page, 'Garden\n'.length)
        await page.keyboard.type('/drawing')
        await expect(page.getByRole('option', { name: /^Drawing/ })).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('Enter')
        await expect.poll(() => getDoc(page)).toMatch(/^Garden\n```excalidraw\.drawing\n\{"type":"excalidraw\.drawing","version":1,"id":"[a-z0-9]{10}","background":"#ffffff"\}\n```\nAfter$/)
        await expect(page.getByTestId('excalidraw-editor')).toBeVisible({ timeout: 30_000 })

        await drawRectangle(page, page.getByTestId('document-editor'))
        await expect.poll(() => getDoc(page), { timeout: 10_000 }).toMatch(/\n\{[^\n]*"type":"rectangle"[^\n]*\}\n```\nAfter$/)

        await page.getByTestId('excalidraw-done').click()
        await expect(page.getByTestId('excalidraw-picture').locator('svg[role="img"]')).toBeVisible({ timeout: 30_000 })
    })

    test('is a picture named by its words, never its lines, and the caret passes over it', async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle, label), 'After'].join('\n'))
        await expect(page.getByRole('img', { name: 'Drawing: Beans' })).toBeVisible({ timeout: 30_000 })
        await expect(page.locator('.cm-line', { hasText: 'rectangle' })).toHaveCount(0)

        // ArrowDown from the start of Garden lands at the start of After, past the drawing's lines.
        await caretAt(page, 0)
        await page.keyboard.press('ArrowDown')
        await page.keyboard.type('x')
        await expect.poll(() => getDoc(page)).toBe(['Garden', drawing('k1', rectangle, label), 'xAfter'].join('\n'))
    })

    test('text typed with a pause shows whole as it is typed, from its first letter, and is saved whole', async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        const editor = page.getByTestId('excalidraw-editor')
        await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        const canvas = (await editor.boundingBox())!
        /** Whether the editing box holds all its text, rather than cutting it off at its edge. */
        const whole = (box: Locator) => box.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)

        // The text tool from Excalidraw's toolbar, as a person picks it, on empty canvas.
        await editor.locator('.ToolIcon[title*="Text"]').first().click()
        await page.mouse.click(canvas.x + canvas.width / 2 + 180, canvas.y + canvas.height / 2)
        const box = editor.locator('textarea.excalidraw-wysiwyg')
        await expect(box).toBeFocused()
        await page.keyboard.type('B')
        // Longer than the drawing waits before it saves.
        await page.waitForTimeout(800)
        await expect(box).toHaveValue('B')
        expect(await whole(box)).toBe(true)
        await page.keyboard.type('eanstalk')

        await expect(box).toHaveValue('Beanstalk')
        expect(await whole(box)).toBe(true)
        await page.keyboard.press('Escape')
        await expect.poll(() => getDoc(page), { timeout: 10_000 }).toMatch(/"text":"Beanstalk"/)
    })

    test('text typed inside a shape is drawn in the shape, and saved bound to it', async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        const editor = page.getByTestId('excalidraw-editor')
        await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        const canvas = (await editor.boundingBox())!

        // The text tool, pressed at the middle of the drawing: inside the rectangle.
        await page.keyboard.press('t')
        await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
        const box = editor.locator('textarea.excalidraw-wysiwyg')
        await expect(box).toBeFocused()
        await page.keyboard.type('Beans')
        await expect(box).toHaveValue('Beans')
        expect((await box.boundingBox())!.width).toBeGreaterThan(30)
        await page.keyboard.press('Escape')
        await expect.poll(() => getDoc(page), { timeout: 10_000 }).toMatch(/"text":"Beans"[^\n]*"containerId":"r1"|"containerId":"r1"[^\n]*"text":"Beans"/)
    })

    test("text typed on an arrow is the arrow's label, drawn on it and saved", async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        const editor = page.getByTestId('excalidraw-editor')
        await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        const canvas = (await editor.boundingBox())!

        // A long arrow across the upper part of the drawing: clear of the rectangle in the middle,
        // the toolbar above it and the controls in the corners.
        const from = { x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.22 }
        const to = { x: canvas.x + canvas.width * 0.85, y: canvas.y + canvas.height * 0.32 }
        await page.keyboard.press('a')
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(to.x, to.y, { steps: 8 })
        await page.mouse.up()
        await page.keyboard.press('Escape')
        await expect.poll(async () => (await drawingLines(page)).some((line) => line.includes('"type":"arrow"')), { timeout: 10_000 }).toBe(true)

        // The text tool, pressed at the arrow's middle: its label.
        await page.keyboard.press('t')
        await page.mouse.click((from.x + to.x) / 2, (from.y + to.y) / 2)
        const box = editor.locator('textarea.excalidraw-wysiwyg')
        await expect(box).toBeFocused()
        await page.keyboard.type('Beans')
        await expect(box).toHaveValue('Beans')
        expect((await box.boundingBox())!.width).toBeGreaterThan(30)
        await page.keyboard.press('Escape')
        await expect.poll(async () => (await drawingLines(page)).some((line) => line.includes('"text":"Beans"') && /"containerId":"[^"]+"/.test(line)), { timeout: 10_000 }).toBe(true)
        // Drawn with a width, so it shows.
        const label = (await drawingLines(page)).find((line) => line.includes('"text":"Beans"'))!
        expect((JSON.parse(label) as { width: number }).width).toBeGreaterThan(20)
    })

    test('text typed on a line is drawn and saved', async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        const editor = page.getByTestId('excalidraw-editor')
        await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        const canvas = (await editor.boundingBox())!

        // A long line across the upper part of the drawing, clear of the rectangle and the controls.
        const from = { x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.22 }
        const to = { x: canvas.x + canvas.width * 0.85, y: canvas.y + canvas.height * 0.32 }
        await page.keyboard.press('l')
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(to.x, to.y, { steps: 8 })
        await page.mouse.up()
        await page.keyboard.press('Escape')
        await expect.poll(async () => (await drawingLines(page)).some((line) => line.includes('"type":"line"')), { timeout: 10_000 }).toBe(true)

        // The text tool, pressed at the line's middle.
        await page.keyboard.press('t')
        await page.mouse.click((from.x + to.x) / 2, (from.y + to.y) / 2)
        const box = editor.locator('textarea.excalidraw-wysiwyg')
        await expect(box).toBeFocused()
        await page.keyboard.type('Beans')
        await expect(box).toHaveValue('Beans')
        expect((await box.boundingBox())!.width).toBeGreaterThan(30)
        await page.keyboard.press('Escape')
        await expect.poll(async () => (await drawingLines(page)).some((line) => line.includes('"text":"Beans"')), { timeout: 10_000 }).toBe(true)
        const label = (await drawingLines(page)).find((line) => line.includes('"text":"Beans"'))!
        expect((JSON.parse(label) as { width: number }).width).toBeGreaterThan(20)
    })

    test('a change from elsewhere while text is typed waits for the text to be finished, and both are kept', async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        const editor = page.getByTestId('excalidraw-editor')
        await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        const canvas = (await editor.boundingBox())!

        await page.keyboard.press('t')
        await page.mouse.click(canvas.x + canvas.width / 2 + 180, canvas.y + canvas.height / 2)
        const box = editor.locator('textarea.excalidraw-wysiwyg')
        await expect(box).toBeFocused()
        await page.keyboard.type('Bean')
        // Another device adds a shape meanwhile.
        const shape = JSON.stringify({ id: 'e2', type: 'ellipse', version: 1, versionNonce: 3, x: 200, y: 0, width: 60, height: 60 })
        await setDoc(page, ['Garden', drawing('k1', rectangle, shape), 'After'].join('\n'))
        await expect(box).toBeFocused()
        await page.keyboard.type('stalk')

        await expect(box).toHaveValue('Beanstalk')
        expect(await box.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        await page.keyboard.press('Escape')
        await expect.poll(() => getDoc(page), { timeout: 10_000 }).toMatch(/"text":"Beanstalk"/)
        expect(await getDoc(page)).toContain('"id":"e2"')
    })

    test('a press on the picture makes it live, and a press outside puts it back', async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        await expect(page.getByTestId('excalidraw-editor')).toBeVisible({ timeout: 30_000 })
        await page.getByText('After').click()
        await expect(page.getByTestId('excalidraw-picture')).toBeVisible()
        await expect(page.getByTestId('excalidraw-editor')).toHaveCount(0)
    })

    test("the picture's menu shows the drawing as text, from the keyboard too", async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await expect(page.getByTestId('excalidraw-picture').locator('svg[role="img"]')).toBeVisible({ timeout: 30_000 })
        const menu = page.getByTestId('excalidraw-menu')
        await menu.focus()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('menuitem', { name: 'Edit as text' })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('menu')).toBeHidden()
        await expect(menu).toBeFocused()

        await menu.click()
        await page.getByRole('menuitem', { name: 'Edit as text' }).click()
        await expect(page.locator('.cm-line', { hasText: '"type":"rectangle"' })).toBeVisible()
    })

    test('Delete in the menu removes the drawing at once, says how to undo it, and Mod+Z brings it back', async ({ page }) => {
        const said = notices(page)
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-menu').click()
        await page.getByRole('menuitem', { name: 'Delete' }).click()
        await expect.poll(() => getDoc(page)).toBe('Garden\nAfter')
        await expect.poll(() => said).toContain('Drawing deleted. Press Ctrl+Z (Cmd+Z on a Mac) in the document to bring it back.')

        await page.getByTestId('document-editor').locator('.cm-content').focus()
        await page.keyboard.press('Control+z')
        await expect.poll(() => getDoc(page)).toBe(['Garden', drawing('k1', rectangle), 'After'].join('\n'))
    })

    test('Edit as text and Delete are in the live toolbar too, and what was drawn is saved first', async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        await drawRectangle(page, page.getByTestId('document-editor'))
        await page.getByTestId('excalidraw-edit-text').click()
        await expect(page.getByTestId('excalidraw-editor')).toHaveCount(0)
        await expect.poll(async () => (await drawingLines(page)).filter((line) => line.includes('"type":"rectangle"')).length).toBe(2)
        await expect(page.locator('.cm-line', { hasText: '"id":"r1"' })).toBeVisible()

        await page.getByText('After').click()
        await page.getByTestId('excalidraw-picture').click()
        await expect(page.getByTestId('excalidraw-editor').locator('canvas').first()).toBeVisible({ timeout: 30_000 })
        await page.getByTestId('excalidraw-delete').click()
        await expect.poll(() => getDoc(page)).toBe('Garden\nAfter')
    })

    test('a save keeps every line Excalidraw could not load, and every line it could not read', async ({ page }) => {
        // A shape type newer than this Excalidraw, and a line someone broke while editing the text.
        const sticky = JSON.stringify({ id: 'n1', type: 'stickynote', version: 1, versionNonce: 3, x: 300, y: 0, width: 100, height: 100 })
        const broken = '{"id":"r9","type":"rect'
        await setDoc(page, ['Garden', drawing('k1', rectangle, sticky, broken), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        await drawRectangle(page, page.getByTestId('document-editor'))
        await expect.poll(async () => (await drawingLines(page)).filter((line) => line.includes('"type":"rectangle"')).length, { timeout: 10_000 }).toBe(2)
        await page.getByTestId('excalidraw-done').click()
        const lines = await drawingLines(page)
        expect(lines).toContain(sticky)
        expect(lines).toContain(broken)
    })

    test('an excalidraw.com share link pasted on an empty line is a drawing to import, fetched only when asked', async ({ page }) => {
        const shared = { type: 'excalidraw', elements: [JSON.parse(rectangle), JSON.parse(label), { id: 'i1', type: 'image', version: 1, versionNonce: 4, x: 0, y: 0, width: 10, height: 10, fileId: 'f1' }], appState: { viewBackgroundColor: '#fdf6e3' } }
        const { bytes, key } = await sharedScene(shared)
        const asked: string[] = []
        await page.route('https://json.excalidraw.com/api/v2/**', (route) => {
            asked.push(route.request().url())
            return route.fulfill({ body: bytes, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } })
        })
        const said = notices(page)
        const link = `https://excalidraw.com/#json=AbC123_-xyz,${key}`
        await setDoc(page, 'Garden\n\nAfter')
        await caretAt(page, 'Garden\n'.length)
        await paste(page, link)
        await expect.poll(() => drawingLines(page)).toEqual([expect.stringMatching(/^\{"type":"excalidraw\.drawing"/), link])
        const card = page.getByTestId('excalidraw-import')
        await expect(card).toContainText('A drawing shared from excalidraw.com')
        expect(asked).toEqual([])

        await card.getByRole('button', { name: 'Import this drawing from excalidraw.com' }).click()
        await expect(page.getByRole('img', { name: 'Drawing: Beans' })).toBeVisible({ timeout: 30_000 })
        expect(asked).toEqual(['https://json.excalidraw.com/api/v2/AbC123_-xyz'])
        const lines = await drawingLines(page)
        expect(lines).not.toContain(link)
        expect(lines[0]).toContain('"background":"#fdf6e3"')
        expect(lines.slice(1)).toEqual([rectangle, label])
        await expect.poll(() => said).toContain('The drawing was imported without its image. Drawings in EtherPK hold no images.')
    })

    test('an import that fails says why, keeps the link, and can be tried again', async ({ page }) => {
        let up = false
        const { bytes, key } = await sharedScene({ elements: [JSON.parse(rectangle)] })
        await page.route('https://json.excalidraw.com/api/v2/**', (route) =>
            up ? route.fulfill({ body: bytes, headers: { 'access-control-allow-origin': '*' } }) : route.fulfill({ status: 404, body: 'missing', headers: { 'access-control-allow-origin': '*' } }),
        )
        const link = `https://excalidraw.com/#json=AbC123_-xyz,${key}`
        await setDoc(page, ['Garden', '```excalidraw.drawing', header('k1'), link, '```', 'After'].join('\n'))
        const card = page.getByTestId('excalidraw-import')
        await card.getByRole('button', { name: 'Import this drawing from excalidraw.com' }).click()
        await expect(card.getByRole('status')).toHaveText('excalidraw.com no longer has this drawing.')
        expect(await drawingLines(page)).toContain(link)

        up = true
        await card.getByRole('button', { name: 'Import this drawing from excalidraw.com' }).click()
        await expect(page.getByTestId('excalidraw-picture').locator('svg[role="img"]')).toBeVisible({ timeout: 30_000 })
    })

    test('shapes copied on excalidraw.com and pasted on an empty line become a drawing of them', async ({ page }) => {
        await setDoc(page, 'Garden\n\nAfter')
        await caretAt(page, 'Garden\n'.length)
        await paste(page, JSON.stringify({ type: 'excalidraw/clipboard', elements: [JSON.parse(rectangle), JSON.parse(label)], files: {} }))
        await expect.poll(async () => (await drawingLines(page)).slice(1)).toEqual([rectangle, label])
        await expect(page.getByRole('img', { name: 'Drawing: Beans' })).toBeVisible({ timeout: 30_000 })
    })

    test('shapes written by hand, without their version, are drawn and written back as full elements', async ({ page }) => {
        const box = JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 160, height: 80, label: { text: 'Beds' } })
        await setDoc(page, ['Garden', drawing('k1', box), 'After'].join('\n'))
        await expect(page.getByRole('img', { name: 'Drawing: Beds' })).toBeVisible({ timeout: 30_000 })
        await expect
            .poll(async () => (await drawingLines(page)).slice(1).map((line) => JSON.parse(line) as { type: string; version?: number }))
            .toEqual([expect.objectContaining({ type: 'rectangle', version: expect.any(Number) }), expect.objectContaining({ type: 'text', text: 'Beds', version: expect.any(Number) })])
    })

    test("the README's hand-written example converts, its arrow joined to both shapes", async ({ page }) => {
        const shapes = [
            '{"id":"beds","type":"rectangle","x":0,"y":0,"width":160,"height":80,"label":{"text":"Beds"}}',
            '{"id":"shed","type":"ellipse","x":300,"y":0,"width":120,"height":80,"label":{"text":"Shed"}}',
            '{"type":"arrow","x":160,"y":40,"start":{"id":"beds"},"end":{"id":"shed"}}',
        ]
        await setDoc(page, ['Garden', drawing('k1', ...shapes), 'After'].join('\n'))
        await expect(page.getByRole('img', { name: 'Drawing: Beds, Shed' })).toBeVisible({ timeout: 30_000 })
        type Written = { id: string; type: string; version?: number; startBinding?: { elementId: string }; endBinding?: { elementId: string } }
        await expect.poll(async () => (await drawingLines(page)).slice(1).every((line) => typeof (JSON.parse(line) as Written).version === 'number')).toBe(true)
        const written = (await drawingLines(page)).slice(1).map((line) => JSON.parse(line) as Written)
        expect(written.find((element) => element.type === 'arrow')).toMatchObject({ startBinding: { elementId: 'beds' }, endBinding: { elementId: 'shed' } })
        expect(written.map((element) => element.type).sort()).toEqual(['arrow', 'ellipse', 'rectangle', 'text', 'text'])
    })
})

test.describe('a drawing in a graph', () => {
    const PLANS = ['---', 'title: Plans', 'public: true', 'publications:', '  - garden', '---', 'The beds for spring.', '', drawing('k1', rectangle, label), '', 'After', ''].join('\n')
    const SITE = '---\ntitle: Garden Site\npublication:\n  id: garden\n  home: Plans\n---\n- [[Plans]]\n'

    test('opens in a tab of its own, live, and what is drawn there reaches the document', async ({ page }) => {
        await openGraph(page, 'drawing-tab', { Plans: PLANS, 'Garden Site': SITE }, 'Plans')
        const inDocument = page.locator('[data-doc-target="Plans"]')
        await inDocument.getByTestId('excalidraw-picture').click()
        await inDocument.getByTestId('excalidraw-open-tab').click()
        // The drawing goes on in the tab, and in the document it is its picture again.
        const tab = page.getByTestId('fence-view')
        await expect(tab.getByTestId('excalidraw-editor')).toBeVisible({ timeout: 30_000 })
        await expect(inDocument.getByTestId('excalidraw-editor')).toHaveCount(0)
        await drawRectangle(page, tab)
        // A second rectangle, on a line of its own beside the first, in the file on disk.
        const rectanglesOnDisk = () =>
            page.evaluate(async () => {
                const root = await navigator.storage.getDirectory()
                const pages = await (await root.getDirectoryHandle('graph-drawing-tab')).getDirectoryHandle('pages')
                const text = await (await (await pages.getFileHandle('Plans.md')).getFile()).text()
                return text.split('\n').filter((line) => line.includes('"type":"rectangle"')).length
            })
        await expect.poll(rectanglesOnDisk, { timeout: 15_000 }).toBe(2)
    })

    test('in the dark theme at full width, what is drawn in the window shows at once', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 900 })
        await page.emulateMedia({ colorScheme: 'dark' })
        await openGraph(page, 'drawing-dark-window', { Plans: ['Intro', drawing('k9'), 'After', ''].join('\n') }, 'Plans')
        const inDocument = page.locator('[data-doc-target="Plans"]')
        await inDocument.getByTestId('excalidraw-picture').click()
        await inDocument.getByTestId('excalidraw-full-window').click()
        const editor = page.getByTestId('fence-window').getByTestId('excalidraw-editor')
        await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        const canvas = (await editor.boundingBox())!
        const at = { x: canvas.x + canvas.width * 0.4, y: canvas.y + canvas.height * 0.4 }
        await page.keyboard.press('r')
        await page.mouse.move(at.x, at.y)
        await page.mouse.down()
        await page.mouse.move(at.x + 200, at.y + 120, { steps: 6 })
        await page.mouse.up()
        await page.keyboard.press('Escape')
        // Off the rectangle, so no selection outline is drawn over it, and then nothing else moves:
        // the page has no other reason to repaint.
        await page.mouse.click(canvas.x + 20, canvas.y + canvas.height - 20)
        const fileText = () =>
            page.evaluate(async () => {
                const root = await navigator.storage.getDirectory()
                const pages = await (await root.getDirectoryHandle('graph-drawing-dark-window')).getDirectoryHandle('pages')
                return (await (await pages.getFileHandle('Plans.md')).getFile()).text()
            })
        await expect.poll(fileText, { timeout: 15_000 }).toMatch(/"type":"rectangle"/)

        // What the screen shows, not what the canvas holds: light pixels in a box around the
        // rectangle, whose stroke is light on the dark canvas, with nothing else in the box.
        const box = { x: Math.round(at.x - 40), y: Math.round(at.y - 40), width: 280, height: 200 }
        const shot = (await page.screenshot({ clip: box })).toString('base64')
        const lit = await page.evaluate(async (shot) => {
            const image = new Image()
            image.src = `data:image/png;base64,${shot}`
            await image.decode()
            const surface = document.createElement('canvas')
            surface.width = image.width
            surface.height = image.height
            const ctx = surface.getContext('2d')!
            ctx.drawImage(image, 0, 0)
            const { data } = ctx.getImageData(0, 0, image.width, image.height)
            let count = 0
            for (let i = 0; i < data.length; i += 4) if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 150) count++
            return count
        }, shot)
        expect(lit).toBeGreaterThan(200)
    })

    test('text typed in its tab with a pause keeps its editing box, and reaches the file whole', async ({ page }) => {
        await openGraph(page, 'drawing-tab-text', { Plans: PLANS, 'Garden Site': SITE }, 'Plans')
        const inDocument = page.locator('[data-doc-target="Plans"]')
        await inDocument.getByTestId('excalidraw-picture').click()
        await inDocument.getByTestId('excalidraw-open-tab').click()
        const editor = page.getByTestId('fence-view').getByTestId('excalidraw-editor')
        await expect(editor.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        const canvas = (await editor.boundingBox())!
        const fileText = () =>
            page.evaluate(async () => {
                const root = await navigator.storage.getDirectory()
                const pages = await (await root.getDirectoryHandle('graph-drawing-tab-text')).getDirectoryHandle('pages')
                return (await (await pages.getFileHandle('Plans.md')).getFile()).text()
            })

        await page.keyboard.press('t')
        await page.mouse.click(canvas.x + canvas.width - 120, canvas.y + 80)
        const box = editor.locator('textarea.excalidraw-wysiwyg')
        await expect(box).toBeFocused()
        await page.keyboard.type('Bean')
        // Longer than the drawing waits before it saves.
        await page.waitForTimeout(800)
        await page.keyboard.type('stalk')

        await expect(box).toHaveValue('Beanstalk')
        expect((await box.boundingBox())!.width).toBeGreaterThan(40)
        await page.keyboard.press('Escape')
        await expect.poll(fileText, { timeout: 15_000 }).toMatch(/"text":"Beanstalk"/)
    })

    test('on a phone it is a picture, a press shows it over the window to look at, and /drawing is not offered', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await openGraph(page, 'drawing-phone', { Plans: PLANS, 'Garden Site': SITE }, 'Plans')
        // A phone opens with the graph's drawer over the document.
        const drawer = page.getByTestId('mobile-drawer-left')
        if (await drawer.isVisible()) await page.mouse.click(375, 400)
        const picture = page.locator('[data-doc-target="Plans"]').getByTestId('excalidraw-picture')
        await expect(picture).toBeVisible({ timeout: 30_000 })
        await picture.click()
        const overlay = page.getByTestId('fence-window')
        await expect(overlay.getByRole('img', { name: 'Drawing: Beans' })).toBeVisible({ timeout: 30_000 })
        await expect(overlay.getByTestId('excalidraw-editor')).toHaveCount(0)
        await page.getByTestId('fence-window-return').click()
        await expect(overlay).toHaveCount(0)

        await page.locator('[data-doc-target="Plans"]').getByText('After').click()
        await page.keyboard.press('End')
        await page.keyboard.press('Enter')
        await page.keyboard.type('/draw')
        await expect(page.getByRole('option', { name: /^Drawing/ })).toHaveCount(0)
    })

    test("is quoted in a document's backlinks as its picture, in the app's theme, and never as its lines", async ({ page }) => {
        const indented = (text: string) =>
            text
                .split('\n')
                .map((line) => `  ${line}`)
                .join('\n')
        const beds = ['- [[Kitchen]] the beds we planned', indented(drawing('q1', rectangle, label)), ''].join('\n')
        await openGraph(page, 'drawing-backlinks', { Kitchen: 'The kitchen garden.\n', Beds: beds }, 'Kitchen')
        const backlinks = page.locator('[data-doc-target="Kitchen"]').getByTestId('document-backlinks')
        const picture = backlinks.getByTestId('reference-fence-picture')
        await expect(picture).toBeVisible({ timeout: 30_000 })
        await expect(picture).toHaveAttribute('alt', 'Drawing: Beans')
        await expect(backlinks).not.toContainText('"type":"rectangle"')
        await expect(backlinks).not.toContainText('excalidraw.drawing')

        // Drawn again for the other theme: a new picture, and a different file.
        const svg = () => picture.evaluate(async (image: HTMLImageElement) => (await fetch(image.src)).text())
        const before = { src: await picture.getAttribute('src'), svg: await svg() }
        expect(before.svg).toContain('<svg')
        const next = (await page.locator('html').getAttribute('data-theme')) === 'dark' ? 'Light' : 'Dark'
        await page.locator(`[data-testid="theme-toggle"] button[aria-label="${next}"]`).first().click()
        await expect.poll(() => picture.getAttribute('src'), { timeout: 30_000 }).not.toBe(before.src)
        expect(await svg()).not.toBe(before.svg)
    })

    test('is published as a picture made by Excalidraw, with its fonts in it, and never as its lines', async ({ page }) => {
        await openGraph(page, 'drawing-publish', { Plans: PLANS, 'Garden Site': SITE }, 'Plans')
        await page.getByTestId('ws-graph-settings').click()
        await page.getByTestId('settings-tab-publish').click()
        await expect(page.getByTestId('publication-garden')).toBeVisible({ timeout: 15_000 })
        const download = page.waitForEvent('download')
        await page.getByTestId('publication-garden-zip').click()
        const zip = unzipSync(new Uint8Array(readFileSync((await (await download).path()) as string)))
        const entries = Object.fromEntries(
            Object.entries(zip)
                .filter(([name]) => /\.(html|svg|json|js|css)$/.test(name))
                .map(([name, data]) => [name, strFromU8(data)]),
        )
        const pictures = Object.keys(entries).filter((name) => /^pictures\/[0-9a-f]{16}\.svg$/.test(name))
        expect(pictures).toHaveLength(1)
        const svg = entries[pictures[0]]
        expect(svg).toContain('<svg')
        expect(svg).toContain('@font-face')
        expect(svg).not.toContain('esm.sh')
        expect(entries['index.html']).toContain(`<figure class="diagram diagram-extension"><img src="${pictures[0]}" alt="Drawing: Beans"`)
        for (const [name, text] of Object.entries(entries)) {
            if (name.endsWith('.svg')) continue
            expect(text, name).not.toContain('"type":"rectangle"')
        }
    })
})
