import { readFileSync } from 'node:fs'

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

    test('a press on the picture makes it live, and a press outside puts it back', async ({ page }) => {
        await setDoc(page, ['Garden', drawing('k1', rectangle), 'After'].join('\n'))
        await page.getByTestId('excalidraw-picture').click()
        await expect(page.getByTestId('excalidraw-editor')).toBeVisible({ timeout: 30_000 })
        await page.getByText('After').click()
        await expect(page.getByTestId('excalidraw-picture')).toBeVisible()
        await expect(page.getByTestId('excalidraw-editor')).toHaveCount(0)
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
