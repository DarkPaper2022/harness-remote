import type { MessageEnvelope } from "./types"

function sameEnvelope(left: MessageEnvelope, right: MessageEnvelope): boolean {
  if (left === right) return true
  if (left.info.id !== right.info.id) return false
  // Message pages arrive as freshly parsed JSON even when nothing changed. Preserve the existing
  // object when the wire payload is identical so long transcripts do not re-render on every poll.
  return JSON.stringify(left.info) === JSON.stringify(right.info)
    && JSON.stringify(left.parts) === JSON.stringify(right.parts)
}

function visibleText(message: MessageEnvelope): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

/**
 * A live ACP reply can be ahead of its append-only journal for a brief moment after the turn becomes
 * idle. The next newest-page reconcile must never replace that complete in-memory reply with an older
 * prefix from disk: doing so makes the answer look cut until the Session is reopened after the journal
 * catches up. Only reject an unambiguous textual regression for the exact same assistant message id;
 * divergent native rewrites are still accepted.
 */
function regressesAssistantText(current: MessageEnvelope, incoming: MessageEnvelope): boolean {
  if (current.info.role !== "assistant" || incoming.info.role !== "assistant") return false
  const currentText = visibleText(current)
  const incomingText = visibleText(incoming)
  return currentText.length > incomingText.length && currentText.startsWith(incomingText)
}

function mergeEnvelopeMonotonically(current: MessageEnvelope, incoming: MessageEnvelope): MessageEnvelope {
  if (sameEnvelope(current, incoming) || regressesAssistantText(current, incoming)) return current
  const incomingByID = new Map(incoming.parts.map((part) => [part.id, part]))
  const currentIDs = new Set(current.parts.map((part) => part.id))
  let partsChanged = false
  const parts = current.parts.map((part) => {
    const next = incomingByID.get(part.id)
    if (!next || JSON.stringify(next) === JSON.stringify(part)) return part
    if (
      part.type === "text" && next.type === "text"
      && typeof part.text === "string" && typeof next.text === "string"
      && part.text.length > next.text.length && part.text.startsWith(next.text)
    ) return part
    partsChanged = true
    return next
  })
  for (const part of incoming.parts) {
    if (currentIDs.has(part.id)) continue
    parts.push(part)
    partsChanged = true
  }
  const infoChanged = JSON.stringify(current.info) !== JSON.stringify(incoming.info)
  if (!partsChanged && !infoChanged) return current
  if (
    parts.length === incoming.parts.length
    && parts.every((part, index) => part === incoming.parts[index])
  ) return incoming
  return { ...incoming, info: infoChanged ? incoming.info : current.info, parts }
}

/**
 * Refresh the newest page without discarding older pages the user explicitly loaded.
 * Reuse both message objects and the array itself when the server did not change anything.
 */
export function mergeLatestMessagePage(existing: MessageEnvelope[], latest: MessageEnvelope[]): MessageEnvelope[] {
  if (!existing.length) return latest
  const latestByID = new Map(latest.map((message) => [message.info.id, message]))
  const existingIDs = new Set(existing.map((message) => message.info.id))
  let changed = false

  const merged = existing.map((message) => {
    const incoming = latestByID.get(message.info.id)
    if (!incoming) return message
    const next = mergeEnvelopeMonotonically(message, incoming)
    if (next === message) return message
    changed = true
    return next
  })
  for (const message of latest) {
    if (existingIDs.has(message.info.id)) continue
    merged.push(message)
    changed = true
  }
  // A delayed final answer may arrive after the next user message was already displayed.
  // Restore chronological order before the timeline splits messages into user-led turns.
  // Stable sorting keeps wire order for equal timestamps; unknown dates keep their old order.
  return changed ? merged.sort((left, right) => {
    const a = Number(left.info.time?.created)
    const b = Number(right.info.time?.created)
    return Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0 ? a - b : 0
  }) : existing
}

/** Add an older page once, keeping the current tail and its object identities intact. */
export function prependOlderMessagePage(existing: MessageEnvelope[], older: MessageEnvelope[]): MessageEnvelope[] {
  if (!existing.length) return older
  const existingIDs = new Set(existing.map((message) => message.info.id))
  const additions = older.filter((message) => !existingIDs.has(message.info.id))
  return additions.length ? [...additions, ...existing] : existing
}
