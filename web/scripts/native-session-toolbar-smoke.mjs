import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import ts from 'typescript'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const styles = [...(await readFile('src/main.tsx', 'utf8')).matchAll(/import "\.\/([^\"]+\.css)"/g)]
  .map(([, file]) => `import '/src/${file}'`).join('\n')
// Mount the production workspace and intercept every daemon request. No real sessions or inference.
const fixture = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { StandaloneUniversalWorkspace } from '/src/components/standalone-universal-workspace'
import { installAppPreferences } from '/src/appPreferences'
installAppPreferences()
${styles}
const machines = [{ id: 'saved', name: 'Test machine', config: { backend: 'codex', host: '127.0.0.1', port: 45000, username: 'test', password: 'test' } }]
createRoot(document.getElementById('root')).render(<StandaloneUniversalWorkspace machines={machines} onPersistMachines={() => {}} />)
`
const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'session-toolbar-fixture',
    resolveId(id) { if (id === '/toolbar-fixture.tsx') return '\0toolbar-fixture.tsx' },
    load(id) {
      if (id === '\0toolbar-fixture.tsx') return ts.transpileModule(fixture, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
      }).outputText
    },
    configureServer(server) {
      server.middlewares.use('/toolbar-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/toolbar-fixture.tsx"></script></html>')
      })
    }
  }]
})
const agent = {
  id: 'codex', label: 'Codex', backend: 'codex', transport: 'acp', managed: true, state: 'available',
  capabilities: { sessions: true, prompt: true, models: true, abort: true }
}
const session = {
  id: 'thread-1', title: 'Toolbar layout test', directory: '/work/project', external: false,
  time: { created: 1, updated: Date.now() }, status: { type: 'idle' },
  model: { providerID: 'codex', id: 'gpt-6-astra', variant: 'high' }
}
const models = [{ providerID: 'codex', modelID: 'gpt-6-astra', modelName: 'GPT-6 Astra with a long model name', variant: 'high', isDefault: true }]
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) })
  await mkdir('browser-artifacts/session-toolbar', { recursive: true })
  for (const [width, height, touch] of [[820, 1180, true], [834, 1194, true], [810, 1080, true], [912, 1368, true], [781, 1180, true], [980, 1180, true], [981, 1180, true], [1024, 1366, true], [768, 1024, true], [744, 1133, true], [390, 844, true], [1180, 820, true], [1440, 900, false]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, locale: 'en-US' })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('http://127.0.0.1:45000/**', async route => {
      const path = new URL(route.request().url()).pathname
      let body = []
      let headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
      if (path.endsWith('/machine')) body = { machine: { id: 'canonical', name: 'Test machine' }, agents: [agent] }
      else if (path.endsWith('/projects')) body = { projects: [{ id: 'project', machineId: 'canonical', name: 'Project', path: '/work/project', kind: 'git' }] }
      else if (path.endsWith('/experimental/session') || path.endsWith('/session')) body = [session]
      else if (path.endsWith('/session/status')) body = { 'thread-1': { type: 'idle' } }
      else if (path.endsWith('/models')) body = { models, stale: false, refreshedAt: new Date().toISOString() }
      else if (path.endsWith('/config/providers')) body = { providers: [], default: {} }
      else if (path.endsWith('/message')) {
        body = [{ info: { id: 'reply', sessionID: session.id, role: 'assistant', time: { created: 1 } }, parts: [{ id: 'reply-text', type: 'text', text: 'The conversation keeps its reading space.', phase: 'final_answer' }] }]
        headers['x-session-model'] = encodeURIComponent(JSON.stringify({ providerID: 'codex', modelID: 'gpt-6-astra', variant: 'high' }))
      } else if (path.endsWith('/event') || path.endsWith('/events')) {
        await route.fulfill({ contentType: 'text/event-stream', headers, body: ': mock stream\n\n' })
        return
      } else if (path.endsWith('/claim')) body = { session, claimed: true }
      else if (path.endsWith('/links')) body = { links: [] }
      else if (path.endsWith('/health')) body = { healthy: true, version: 'test' }
      await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) })
    })
    await page.goto(server.resolvedUrls.local[0] + 'toolbar-test')
    await page.locator('.hr-native-session-row').filter({ hasText: session.title }).click()
    const toolbar = page.locator('.hr-native-session-observer .tdw-conversation-toolbar')
    await toolbar.waitFor()
    await page.locator('.tdw-model-trigger:not(:disabled)').waitFor()
    // Mobile detail slides into view; measure only once its real viewport geometry has settled.
    await page.waitForFunction(() => {
      const box = document.querySelector('.hr-native-workspace-detail').getBoundingClientRect()
      return box.left >= -1 && box.right <= innerWidth + 1
    })
    const geometry = await toolbar.evaluate(element => {
      const box = element.getBoundingClientRect()
      const controls = element.querySelector('.tdw-agent-control')
      const group = controls.getBoundingClientRect()
      const tools = element.querySelector('.tdw-conversation-tools').getBoundingClientRect()
      const harness = controls.querySelector('select').getBoundingClientRect()
      const model = controls.querySelector('.tdw-model-trigger').getBoundingClientRect()
      const pane = element.closest('.hr-native-workspace-detail').getBoundingClientRect()
      return { toolbar: box.height, group: group.height, direction: getComputedStyle(element).flexDirection,
        harnessTop: harness.top, modelTop: model.top, modelRight: model.right, toolsLeft: tools.left, toolsRight: tools.right,
        paneRight: pane.right, paneWidth: pane.width }
    })
    console.log(`${width}x${height}:`, geometry)
    await page.screenshot({ path: `browser-artifacts/session-toolbar/${width}x${height}.png` })
    assert.ok(geometry.toolbar <= 92, `toolbar must be content-sized at ${width}px, got ${geometry.toolbar}px`)
    assert.ok(geometry.group <= 64, `controls must not grow vertically at ${width}px`)
    assert.ok(Math.abs(geometry.harnessTop - geometry.modelTop) <= 6, 'Harness and Model stay on the same row')
    assert.ok(Math.max(geometry.modelRight, geometry.toolsRight) <= geometry.paneRight + 1, 'controls must stay inside the detail pane')
    assert.ok(geometry.modelRight <= geometry.toolsLeft - 4, 'the model control must not overlap status or refresh tools')
    await page.locator('.tdw-model-trigger').click()
    await page.locator('.tdw-model-popover').waitFor()
    const popup = await page.locator('.tdw-model-popover').boundingBox()
    assert.ok(popup.x >= 0 && popup.x + popup.width <= width + 1, 'model menu stays on screen')
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('Native Session toolbar browser checks passed')
} finally {
  await browser?.close()
  await server.close()
}
