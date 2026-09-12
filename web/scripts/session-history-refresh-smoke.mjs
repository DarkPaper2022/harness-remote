import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
import ts from 'typescript'
import { chromium } from 'playwright'

// Exercise the production WorkThreadConversation + SessionHistoryRefresh path with a fake
// controller. No prompt, claim, stop, or continue request can reach a real daemon.
const styles = [...readFileSync('src/main.tsx', 'utf8').matchAll(/import "\.\/([^\"]+\.css)"/g)]
  .map(([, file]) => `import '/src/${file}'`).join('\n')
const fixture = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { WorkThreadConversation } from '/src/components/work-thread-conversation.tsx'
import { installAppPreferences } from '/src/appPreferences'
installAppPreferences()
${styles}
const config = { backend: 'codex', agentId: 'codex', host: '127.0.0.1', port: 4500, username: 'test', password: 'test' }
const agents = [{ id: 'codex', label: 'Codex', backend: 'codex', transport: 'acp', managed: true, state: 'available', capabilities: { sessions: true, prompt: true, models: true } }]
const conversation = { id: 'conversation-1', machineId: 'machine-1', title: 'Refresh smoke', agentId: 'codex', initialPrompt: 'hello', status: 'running', directory: '/work/project', currentTurn: { id: 'turn-1', sequence: 1, agentId: 'codex', sessionId: 'thread-1', directory: '/work/project', status: 'running', prompt: 'hello' }, turns: [{ id: 'turn-1', sequence: 1, agentId: 'codex', sessionId: 'thread-1', directory: '/work/project', status: 'running', prompt: 'hello' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z' }
const text = (id, value, phase = "commentary") => ({ info: { id, role: 'assistant', sessionID: 'thread-1', time: { created: Date.now() } }, parts: [{ id: id + '-part', type: 'text', text: value, phase }] })
const user = { info: { id: 'user-1', role: 'user', sessionID: 'thread-1', time: { created: Date.now() - 1 } }, parts: [{ id: 'user-part', type: 'text', text: 'hello' }] }
let recovered = false, failNext = false, gate = null
window.refreshStats = { loads: 0, continue: 0, stop: 0, flags: [] }
window.recoverMessage = () => { recovered = true }
window.failNextRefresh = () => { failNext = true }
window.holdNextRead = () => { gate = new Promise(resolve => { window.finishRead = resolve }) }
const controller = {
  loadMessagePage: async (_config, _session, _directory, _before, _limit, refreshHistory) => {
    window.refreshStats.loads++
    window.refreshStats.flags.push(refreshHistory)
    const wait = gate; gate = null
    if (wait) await wait
    if (failNext) { failNext = false; throw new Error('simulated refresh failure') }
    return { messages: recovered ? [user, text('assistant-1', 'First answer'), text('assistant-2', 'Recovered answer', 'final_answer')] : [user, text('assistant-1', 'First answer')], hasMore: false }
  },
  refreshConversation: async () => conversation,
  continueConversation: async () => { window.refreshStats.continue++; throw new Error('continue must not run') },
  stopConversation: async () => { window.refreshStats.stop++; throw new Error('stop must not run') }
}
function Fixture() {
  return <div className="hr-control-plane"><div className="hr-native-session-observer" style={{height:"100vh"}}><WorkThreadConversation conversation={conversation} baseConfig={config} agents={agents} controller={controller} onConversationUpdate={() => {}} interactionEnabled={true} /></div></div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`

const server = await createServer({
  configFile: false,
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'session-history-refresh-fixture',
    resolveId(id) { if (id === '/fixture.tsx') return '\\0fixture.tsx' },
    load(id) {
      if (id !== '\\0fixture.tsx') return
      return ts.transpileModule(fixture, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    },
    configureServer(server) {
      server.middlewares.use('/history-refresh-test', (_req, res) => {
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
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    const mutations = []
    await page.route('http://127.0.0.1:4500/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() !== "GET") mutations.push(url.pathname)
      // Model/attention/live-tail probes are incidental to this transcript smoke. Keep them
      // deterministic and make sure no mutation endpoint can silently succeed.
      if (url.pathname.includes('/event')) return route.fulfill({ status: 404, body: '' })
      if (url.pathname.includes('/models')) return route.fulfill({status: 200, contentType:'application/json', body:JSON.stringify({models:[{providerID:'codex',modelID:'test',name:'Test',isDefault:true}]})})
      if (/question|permission/.test(url.pathname)) return route.fulfill({status:200,contentType:'application/json',body:'[]'})
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
    })
    await page.goto(server.resolvedUrls.local[0] + 'history-refresh-test')
    const refresh = page.getByRole('button', { name: 'Refresh session history', exact: true })
    await refresh.waitFor()
    // Active assistant text is intentionally folded into Activity by the existing renderer.
    await page.locator('.uw-activity-group > summary').first().click()
    await page.getByText('First answer', { exact: true }).waitFor().catch(async error => { console.error(await page.locator('body').innerText(), await page.evaluate(() => window.refreshStats)); await page.screenshot({path:'/tmp/history-refresh-failure.png'}); throw error })
    const box = await refresh.boundingBox()
    assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 844, '44px refresh button must remain inside viewport')

    await page.locator('textarea').fill('draft survives refresh failure')
    const beforeLoads = await page.evaluate(() => window.refreshStats.loads)
    await page.evaluate(() => { window.recoverMessage(); window.holdNextRead() })
    await refresh.evaluate(button => { button.click(); button.click() })
    const refreshing = page.getByRole('button', {name: 'Refreshing session history', exact:true})
    assert.equal(await refreshing.isDisabled(), true)
    assert.equal(await page.evaluate(() => window.refreshStats.loads), beforeLoads + 1, 'duplicate clicks must share one in-flight refresh')
    await page.evaluate(() => window.finishRead())
    await page.getByText('Recovered answer', { exact: true }).waitFor()
    assert.equal(await page.getByText('Recovered answer', { exact: true }).evaluate(node => Boolean(node.closest('details'))), false, 'explicit final text must remain outside Activity while the runtime is still running')
    assert.equal(await page.locator('textarea').inputValue(), 'draft survives refresh failure')
    assert.equal(await page.evaluate(() => window.refreshStats.continue + window.refreshStats.stop), 0)

    await page.evaluate(() => window.failNextRefresh())
    await refresh.click()
    await page.getByRole('alert').filter({ hasText: 'Session refresh failed.' }).waitFor()
    assert.equal(await page.getByText('Recovered answer', { exact: true }).count(), 1, 'failed refresh must retain existing transcript')
    assert.equal(await page.locator('textarea').inputValue(), 'draft survives refresh failure')
    assert.equal(await page.evaluate(() => window.refreshStats.continue + window.refreshStats.stop), 0)
    await refresh.click()
    await page.getByRole('status').filter({hasText:'History refreshed'}).waitFor()
    assert.deepEqual(await page.evaluate(() => [...new Set(window.refreshStats.flags)]), [false], 'history reads must not replay or claim the writer')
    assert.deepEqual(mutations, [])
    assert.deepEqual(errors, [])
    await context.close()
    console.log('Session history refresh browser flow PASS:', width)
  }
} finally {
  await browser?.close()
  await server.close()
}
