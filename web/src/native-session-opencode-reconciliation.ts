import type { MessageEnvelope } from "./types"

function assistantHasTerminalText(message: MessageEnvelope): boolean {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]
    if (part.type === "step-start" || part.type === "step-finish" || part.type === "snapshot" || part.type === "patch") continue
    if (part.type === "text") return Boolean(part.text?.trim())
    if (part.type === "reasoning" || part.type === "tool") return false
  }
  return false
}

/**
 * An OpenCode assistant envelope is message-level, not necessarily user-turn-level. Tool steps can
 * finish, and a provider/router can emit an interrupted/error envelope, while OpenCode immediately
 * continues the same user turn. A finish marker alone is not final-answer proof: real OpenCode can
 * persist `finish: "stop"` on a reasoning-only envelope before any user-visible answer exists. Treat
 * only a newest non-error assistant envelope that also contains terminal assistant text as transcript
 * proof that the user turn completed. Ambiguous no-final/error cases are settled from native Session
 * state instead of being projected as a successful Ready turn.
 */
export function openCodeAssistantProvesTurnCompleted(message: MessageEnvelope): boolean {
  if (message.info.role !== "assistant" || message.info.error) return false
  const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
  if (typeof info.finish === "string" && info.finish.trim()) {
    const finish = info.finish.trim().toLowerCase()
    if (finish === "tool" || finish === "tool-call" || finish === "tool-calls" || finish === "tool_calls") return false
    return assistantHasTerminalText(message)
  }
  return Boolean(message.info.time?.completed) && assistantHasTerminalText(message)
}

export function openCodeAssistantHasActivity(message: MessageEnvelope): boolean {
  if (message.info.role !== "assistant") return false
  if (message.info.error) return true
  const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
  return Boolean(
    message.parts.length
    || (typeof info.finish === "string" && info.finish.trim())
  )
}
