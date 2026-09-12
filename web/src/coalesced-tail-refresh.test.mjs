import assert from "node:assert/strict"
import test from "node:test"
import { createCoalescedTailRefresh } from "./coalesced-tail-refresh.ts"

test("an in-flight tail read cannot swallow the final authoritative transcript refresh", async () => {
  const refresh = createCoalescedTailRefresh()
  let authoritativeText = "The answer starts"
  let visibleText = ""
  let reads = 0
  let releaseFirstRead
  const firstReadBlocked = new Promise((resolve) => { releaseFirstRead = resolve })

  const readAndApplyAuthoritativeTail = async () => {
    reads += 1
    const snapshot = authoritativeText
    if (reads === 1) await firstReadBlocked
    visibleText = snapshot
  }

  // The Session stays mounted. The first event starts a read whose snapshot is still incomplete.
  const firstRefresh = refresh(readAndApplyAuthoritativeTail)

  // More streaming chunks arrive while that read is in flight. Historically these refresh requests
  // were dropped by `if (tailInFlightRef.current) return`.
  authoritativeText = "The answer starts and keeps streaming"
  void refresh(readAndApplyAuthoritativeTail)

  // The final assistant state becomes authoritative before the first request resolves.
  authoritativeText = "The answer starts and keeps streaming until the complete final sentence."
  void refresh(readAndApplyAuthoritativeTail)

  releaseFirstRead()
  await firstRefresh

  assert.equal(reads, 2, "the burst should coalesce into the in-flight read plus one trailing read")
  assert.equal(visibleText, authoritativeText, "the still-open Session must converge to the authoritative final transcript")
})

test("manual refresh survives stream events and completes before trailing automatic reads", async () => {
  const refresh = createCoalescedTailRefresh()
  const calls = []
  let releaseFirst, releaseTrailing
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const trailingGate = new Promise(resolve => { releaseTrailing = resolve })
  const first = refresh(async () => { calls.push("first"); await firstGate })
  const manual = refresh(async () => { calls.push("manual") }, true)
  const trailing = refresh(async () => { calls.push("trailing"); await trailingGate })
  releaseFirst()
  await manual
  assert.ok(calls.includes("manual"), "stream events must not replace the explicit request")
  releaseTrailing()
  await Promise.all([first, trailing])
  assert.deepEqual(calls, ["first", "manual", "trailing"])
})

test("manual refresh failure is reported to its caller without breaking live refresh", async () => {
  const refresh = createCoalescedTailRefresh()
  await assert.rejects(refresh(async () => { throw new Error("offline") }, true), /offline/)
  let recovered = false
  await refresh(async () => { recovered = true })
  assert.equal(recovered, true)
})
