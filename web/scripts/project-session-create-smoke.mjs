import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
import ts from 'typescript'
import { chromium } from 'playwright'

// Uses only mock machines: no real sessions, credentials, or inference requests.
const styles = [...readFileSync('src/main.tsx', 'utf8').matchAll(/import "\.\/([^"]+\.css)"/g)]
  .map(([, file]) => `import '/src/${file}'`).join('\n')
const fixture = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NativeSessionHome } from '/src/components/native-session-home.tsx'
import { installAppPreferences } from '/src/appPreferences'
installAppPreferences()
${styles}
import '/src/taskdesk-workthreads.css'
const initial = [1, 2].map(n => ({
  machine: { id: 'saved-' + n, name: 'Machine ' + n, config: { backend: 'codex', host: '127.0.0.1', port: 45000 + n, username: 'test', password: 'test' } },
  snapshot: { machine: { id: 'canonical-' + n, name: 'Machine ' + n }, agents: [{ id: 'codex', label: 'Codex', backend: 'codex', transport: 'acp', state: 'available', capabilities: { sessions: true, prompt: true } }] },
  state: 'online'
}))
function Fixture() {
  const [sources, setSources] = useState(initial)
  window.setMachineOffline = () => setSources(s => s.map(x => x.machine.id === 'saved-2' ? { ...x, state: 'offline' } : x))
  return <div className="tdw-shell" style={{ display: "block", height: "auto", overflow: "visible" }}><NativeSessionHome sources={sources} onOpen={target => { window.openedSession = target }} /></div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`
const server = await createServer({
  configFile: false,
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'project-session-fixture',
    resolveId(id) { if (id === '/fixture.tsx') return '\0fixture.tsx' },
    load(id) { if (id === '\0fixture.tsx') return ts.transpileModule(fixture, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText },
    configureServer(server) {
      server.middlewares.use('/project-test', (_req, res) => {
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
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message) })
    let posts = []
    let failCreate = true
    await page.route('http://127.0.0.1:4500*/**', async route => {
      const url = new URL(route.request().url())
      const n = Number(url.port) - 45000
      const directory = '/work/shared'
      let body = []
      let status = 200
      if (url.pathname === '/v1/projects') body = { projects: [
        { id: 'first', machineId: 'canonical-' + n, name: 'First project', path: '/work/first', kind: 'git' },
        { id: 'shared', machineId: 'canonical-' + n, name: 'Shared project', path: directory, kind: 'git' }
      ] }
      else if (url.pathname.endsWith('/experimental/session')) body = [{ id: 'existing-' + n, title: 'Existing ' + n, directory, external: true, time: { created: n, updated: n } }]
      else if (url.pathname.endsWith('/session/status')) body = {}
      else if (route.request().method() === 'POST' && url.pathname.endsWith('/session')) {
        posts.push({ port: url.port, directory: url.searchParams.get('directory'), body: route.request().postDataJSON() })
        await new Promise(resolve => setTimeout(resolve, 150))
        if (failCreate) { status = 400; body = { error: 'Simulated create failure' } }
        else body = { id: 'created', title: 'Created project session', directory, time: { created: 5, updated: 5 } }
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(server.resolvedUrls.local[0] + 'project-test')
    const group = page.locator('.hr-native-machine-group').filter({ has: page.locator('.hr-native-machine-identity strong').getByText('Machine 2', { exact: true }) }).locator('.hr-native-project-group')
    const shortcut = group.getByRole('button', { name: 'New session in Shared project', exact: true })
    await shortcut.waitFor({ timeout: 10000 }).catch(async error => {
      console.error((await page.locator('body').innerText()).slice(0, 2500))
      throw error
    })
    const disclosure = group.locator('.hr-native-project-heading')
    await disclosure.click()
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
    await shortcut.click()
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false', 'create must not expand the project')
    const panel = page.locator('.hr-native-create-panel')
    // Locate by existing labels rather than relying on select ordering.
    const machine = panel.getByRole('combobox', { name: 'Filter by machine' })
    const project = page.getByLabel('Project', { exact: true })
    assert.equal(await machine.inputValue(), 'saved-2')
    assert.equal(await project.inputValue(), 'saved-2:shared')
    assert.equal(await machine.isDisabled(), true)
    assert.equal(await project.isDisabled(), true)
    const create = panel.getByRole('button', { name: /Create Session/ })
    await mkdir('browser-artifacts', { recursive: true })
    await page.screenshot({ path: 'browser-artifacts/project-create-ready-' + width + '.png', fullPage: true })
    await create.click()
    await page.getByRole('alert').filter({ hasText: 'Simulated create failure' }).waitFor()
    assert.equal(posts.length, 1)
    assert.equal(await project.inputValue(), 'saved-2:shared', 'failure must preserve the project')
    failCreate = false
    await create.click()
    await page.waitForFunction(() => window.openedSession?.sessionID === 'created' || window.openedSession?.session?.id === 'created')
    assert.equal(posts.length, 2)
    assert.ok(posts.every(p => p.port === '45002' && p.directory === '/work/shared'), JSON.stringify(posts))
    await page.getByRole('button', { name: 'New Session', exact: true }).click()
    assert.equal(await page.getByLabel('Project', { exact: true }).isDisabled(), false, 'global create must clear project pin')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await shortcut.click()
    await page.evaluate(() => window.setMachineOffline())
    await page.getByRole('alert').filter({ hasText: 'This project or its machine is unavailable' }).waitFor()
    assert.equal(await create.isDisabled(), true, 'offline target must not fall back to another machine')
    assert.equal(await machine.inputValue(), 'saved-2')
    assert.equal(await project.inputValue(), 'saved-2:shared')
    assert.equal(posts.length, 2)
    assert.deepEqual(errors, [])
    await mkdir('browser-artifacts', { recursive: true })
    await page.screenshot({ path: 'browser-artifacts/project-create-' + width + '.png', fullPage: true })
    await context.close()
    console.log('Project create browser flow PASS:', width)
  }
} finally {
  await browser?.close()
  await server.close()
}
