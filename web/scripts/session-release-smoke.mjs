import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
import ts from 'typescript'
import { chromium } from 'playwright'

// Browser-level coverage for the real NativeSessionActions component. The request is intercepted,
// so this exercises UI state and api.releaseSession without requiring a daemon or a real session.
const styles = [...readFileSync('src/main.tsx', 'utf8').matchAll(/import "\.\/([^\"]+\.css)"/g)]
  .map(([, file]) => `import '/src/${file}'`).join('\n')
const fixture = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NativeSessionActions } from '/src/components/native-session-actions.tsx'
import { installAppPreferences } from '/src/appPreferences'
installAppPreferences()
${styles}
const config = { backend: 'codex', agentId: 'codex', host: '127.0.0.1', port: 4500, username: 'test', password: 'test' }
const target = { key: 'machine-1:codex:thread-1', ref: { machineID: 'machine-1', agentID: 'codex', sessionID: 'thread-1' }, machineID: 'machine-1', sessionID: 'thread-1', directory: '/work/project', title: 'Release smoke', agentID: 'codex', agentLabel: 'Codex', backend: 'codex', transport: 'acp', config, external: true, modelsSupported: true, renameSupported: false, deleteSupported: false, model: null }
const piTarget = { ...target, key: 'machine-1:pi:thread-pi', agentID: 'pi', agentLabel: 'PI', backend: 'pi', config: { ...config, backend: 'pi' } }
function Fixture() {
  const [released, setReleased] = useState('')
  const [externalBusy, setExternalBusy] = useState(false)
  return <div>
    <div data-testid="codex"><NativeSessionActions target={target} busy={externalBusy} onReleased={key => setReleased(key)} /></div>
    <div data-testid="pi"><NativeSessionActions target={piTarget} onReleased={key => setReleased(key)} /></div>
    <button onClick={() => setExternalBusy(value => !value)}>toggle busy</button>
    {released ? <output data-testid="released">released:{released}</output> : null}
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`

const server = await createServer({
  configFile: false,
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'session-release-fixture',
    resolveId(id) { if (id === '/fixture.tsx') return '\\0fixture.tsx' },
    load(id) {
      if (id !== '\\0fixture.tsx') return
      return ts.transpileModule(fixture, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    },
    configureServer(server) {
      server.middlewares.use('/release-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>')
      })
    }
  }]
})

let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'en-US' })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const requests = []
    let failedOnce = false
    await page.route('http://127.0.0.1:4500/**', async route => {
      const request = route.request()
      requests.push(new URL(request.url()))
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/agents/codex/session/thread-1/release') {
        if (!failedOnce) {
          failedOnce = true
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy on server' }) })
        } else {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ released: true, sessionID: 'thread-1' }) })
        }
      } else await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    })
    await page.goto(server.resolvedUrls.local[0] + 'release-test')
    const codex = page.getByTestId('codex')
    const pi = page.getByTestId('pi')
    assert.equal(await pi.locator('button').count(), 0, 'non-Codex sessions must not show release controls')
    const release = codex.getByRole('button', { name: 'Release Session', exact: true })
    assert.equal(await release.isDisabled(), false)
    await page.getByRole('button', { name: 'toggle busy' }).click()
    assert.equal(await release.isDisabled(), true, 'working/external-busy sessions must disable release')
    await page.getByRole('button', { name: 'toggle busy' }).click()
    await release.click()
    const dialog = page.getByRole('dialog', { name: 'Release Session' })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await page.getByRole('dialog').count(), 0, 'cancel must close confirmation without a request')
    await release.click()
    await dialog.getByRole('button', { name: 'Release Session', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'busy on server' }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 1, 'release errors must keep the confirmation panel open')
    await dialog.getByRole('button', { name: 'Release Session', exact: true }).click()
    await page.getByTestId('released').waitFor()
    assert.equal(await page.getByTestId('released').innerText(), 'released:machine-1:codex:thread-1')
    const releaseRequests = requests.filter(url => url.pathname.includes('/release'))
    assert.deepEqual(releaseRequests.map(url => url.pathname), ['/v1/agents/codex/session/thread-1/release', '/v1/agents/codex/session/thread-1/release'], 'release path must contain exactly one agent/session prefix')
    assert.deepEqual(errors, [])
    await context.close()
    console.log('Session release browser flow PASS:', width)
  }
} finally {
  await browser?.close()
  await server.close()
}
