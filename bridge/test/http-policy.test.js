import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig } from "../src/config.js"
import { allowedOrigin, applyCorsHeaders, normalizeCorsOrigin } from "../src/http-policy.js"

function request(origin, extraHeaders = {}) {
  return { headers: { origin, ...extraHeaders } }
}

function response() {
  const headers = new Map()
  return {
    headers,
    setHeader(name, value) { headers.set(name, value) }
  }
}

test("normalizes a browser-copied trailing slash in a CORS origin", () => {
  assert.equal(normalizeCorsOrigin(" http://localhost:5173/ "), "http://localhost:5173")
  assert.equal(
    allowedOrigin(request("http://localhost:5173"), parseConfig(["--cors", "http://localhost:5173/"], {})),
    "http://localhost:5173"
  )
})

test("emits credentialed CORS headers for a normalized origin", () => {
  const result = response()
  applyCorsHeaders(request("http://localhost:5173"), result, { corsOrigins: ["http://localhost:5173/"] })
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173")
  assert.equal(result.headers.get("Access-Control-Allow-Credentials"), "true")
})

test("does not turn a path into an allowed origin", () => {
  assert.equal(
    allowedOrigin(request("http://localhost:5173"), { corsOrigins: ["http://localhost:5173/app/"] }),
    undefined
  )
})
