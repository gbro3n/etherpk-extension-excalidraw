import { resolve } from 'node:path'

import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests against a real EtherPK Client that side-loads this extension.
 *
 * The Client is a checkout of the EtherPK repository, at `ETHERPK_CLIENT_DIR` (`../etherpk` when
 * unset), run as a development server: only a development server reads `ETHERPK_DEV_EXTENSIONS`,
 * the folders it loads extensions from. The extension is built first, so the Client serves the
 * `dist/` this repository would publish.
 *
 * On a machine where Playwright's own Chromium will not start, `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
 * names another.
 */
const CLIENT_DIR = resolve(process.env.ETHERPK_CLIENT_DIR ?? '../etherpk')
const PORT = Number(process.env.ETHERPK_CLIENT_PORT ?? 5397)
const ORIGIN = `http://127.0.0.1:${PORT}`

export default defineConfig({
    testDir: './tests',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : 2,
    reporter: [['list']],
    use: {
        baseURL: ORIGIN,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        actionTimeout: 15_000,
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } } : {}),
            },
        },
    ],
    webServer: {
        // The Client's own loaded extensions are built first, as its `dev` script does.
        command: [
            'pnpm build',
            `pnpm --dir "${CLIENT_DIR}/apps/client" exec node build-extensions.mjs`,
            `pnpm --dir "${CLIENT_DIR}/apps/client" exec vite dev --host 127.0.0.1 --port ${PORT} --strictPort`,
        ].join(' && '),
        url: ORIGIN,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
            ETHERPK_DEV_EXTENSIONS: resolve('.'),
            // No managed sign-in: these tests use local graphs only.
            CORPORATE_ISSUER: '',
            MANAGED_OAUTH_CLIENT_ID: '',
            MANAGED_SYNC_URL: '',
            CLIENT_SESSION_SECRET: '',
        },
    },
})
