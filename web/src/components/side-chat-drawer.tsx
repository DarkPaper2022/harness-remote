import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { CloseIcon, LoadingIcon } from "../Icons"
import { messageText } from "../message-content"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import { sendNativeSessionPrompt } from "../native-session-prompt"
import type { MessageEnvelope, ModelSelection } from "../types"
import { TaskDeskMessageContent } from "./taskdesk-message-content"

export type SideChatLaunchState = {
  initialQuestion?: string
  model?: ModelSelection | null
}

type Props = {
  parentTarget: NativeSessionSurfaceTarget
  parentMessages: MessageEnvelope[]
  launchState: SideChatLaunchState
  onClose: () => void
}

function buildSideChatContext(parentTitle: string, messages: MessageEnvelope[]): string {
  const recent = messages.slice(-12)
  const lines: string[] = [
    "[SIDE CHAT (/btw) CONTEXT — Read-only aside from the parent session. Answer concisely without modifying files unless explicitly asked.]",
    `Parent Session: ${parentTitle}`
  ]
  for (const msg of recent) {
    const text = messageText(msg).trim()
    if (!text) continue
    const role = msg.info.role === "user" ? "User" : "Assistant"
    const clipped = text.length > 900 ? `${text.slice(0, 900)}…` : text
    lines.push(`\n${role}:\n${clipped}`)
  }
  return lines.join("\n").slice(0, 6_000)
}

export function SideChatDrawer({
  parentTarget,
  parentMessages,
  launchState,
  onClose
}: Props) {
  const [sideTarget, setSideTarget] = useState<NativeSessionSurfaceTarget | null>(null)
  const [messages, setMessages] = useState<MessageEnvelope[]>([])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createdSessionIDRef = useRef<string | null>(null)
  const bootedRef = useRef(false)
  const contextSentRef = useRef(false)
  const parentSnapshotRef = useRef(parentMessages)
  parentSnapshotRef.current = parentMessages

  async function refreshSideMessages(target: NativeSessionSurfaceTarget) {
    try {
      const page = await api.loadMessagePage(target.config, target.sessionID, target.directory, undefined, 60, false)
      setMessages(page.messages)
      return page.messages
    } catch {
      return []
    }
  }

  async function askInSideChat(questionText: string, existingTarget?: NativeSessionSurfaceTarget | null) {
    const trimmed = questionText.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      let target = existingTarget ?? sideTarget
      if (!target) {
        const created = await api.createSession(
          parentTarget.config,
          `[btw] ${trimmed.slice(0, 42)}`,
          launchState.model ?? undefined,
          parentTarget.directory
        )
        createdSessionIDRef.current = created.id
        target = {
          ...parentTarget,
          key: `${parentTarget.machineID}:${parentTarget.agentID}:${created.id}`,
          sessionID: created.id,
          title: created.title || `[btw] ${trimmed.slice(0, 42)}`,
          external: false,
          ref: {
            ...parentTarget.ref,
            sessionID: created.id
          }
        }
        setSideTarget(target)
      }

      const wirePrompt = !contextSentRef.current
        ? `${buildSideChatContext(parentTarget.title, parentSnapshotRef.current)}\n\n---\nSide question (/btw):\n${trimmed}`
        : trimmed
      contextSentRef.current = true

      await sendNativeSessionPrompt(target, wirePrompt, launchState.model ?? null, [])
      await refreshSideMessages(target)

      // Poll until the side-chat turn settles or 45s elapses.
      const started = Date.now()
      while (Date.now() - started < 45_000) {
        await new Promise((resolve) => window.setTimeout(resolve, 750))
        const statuses: Record<string, { type?: string }> = await api
          .listStatuses(target.config, target.directory)
          .catch(() => ({}))
        const latest = await refreshSideMessages(target)
        const statusType = statuses[target.sessionID]?.type
        const hasAssistantReply = latest.some((item) => item.info.role === "assistant" && messageText(item).trim().length > 0)
        if (statusType === "idle" && hasAssistantReply) break
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    if (launchState.initialQuestion?.trim()) {
      void askInSideChat(launchState.initialQuestion.trim(), null)
    }
  }, [launchState.initialQuestion])

  async function handleClose(discard = true) {
    const sessionID = createdSessionIDRef.current
    createdSessionIDRef.current = null
    onClose()
    if (discard && sessionID && parentTarget.deleteSupported) {
      void api.deleteSession(parentTarget.config, sessionID, parentTarget.directory).catch(() => undefined)
    }
  }

  const displayMessages = useMemo(() => messages.map((msg, idx) => {
    if (idx === 0 && msg.info.role === "user") {
      const marker = "Side question (/btw):\n"
      const parts = msg.parts.map((part) => {
        if (part.type === "text" && typeof part.text === "string" && part.text.includes(marker)) {
          return { ...part, text: part.text.slice(part.text.indexOf(marker) + marker.length) }
        }
        return part
      })
      return { ...msg, parts }
    }
    return msg
  }), [messages])

  return (
    <aside className="hr-side-chat-drawer" aria-label="Side chat (/btw)">
      <header className="hr-side-chat-header">
        <div>
          <span className="hr-side-chat-badge">/btw · 侧聊</span>
          <strong>{parentTarget.agentLabel}</strong>
        </div>
        <div className="hr-side-chat-header-actions">
          {sideTarget ? (
            <button
              type="button"
              className="tdw-button secondary"
              onClick={() => void handleClose(false)}
              title="Keep this side chat in session history"
            >
              保留会话
            </button>
          ) : null}
          <button
            type="button"
            className="tdw-icon-button"
            onClick={() => void handleClose(true)}
            aria-label="Close side chat"
            title="关闭并清理临时侧聊"
          >
            <CloseIcon size={15} />
          </button>
        </div>
      </header>

      <div className="hr-side-chat-body">
        {displayMessages.length === 0 && !busy && !error ? (
          <div className="hr-side-chat-empty">
            在不打断主会话运行、不污染主上下文的前提下提问旁支问题（<code>/btw</code> 或 <code>/side</code>）。关闭时默认自动清理该临时会话。
          </div>
        ) : null}
        {displayMessages.map((msg) => (
          <article key={msg.info.id} className={`hr-side-chat-msg ${msg.info.role}`}>
            <header>{msg.info.role === "user" ? "你" : parentTarget.agentLabel}</header>
            <TaskDeskMessageContent message={msg} />
          </article>
        ))}
        {busy ? (
          <div className="hr-side-chat-thinking">
            <LoadingIcon size={14} /> <span>正在侧聊中思考…</span>
          </div>
        ) : null}
        {error ? <div className="hr-side-chat-error" role="alert">{error}</div> : null}
      </div>

      <form
        className="hr-side-chat-composer"
        onSubmit={(event) => {
          event.preventDefault()
          const next = draft.trim()
          if (!next || busy) return
          setDraft("")
          void askInSideChat(next)
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="继续追问旁支问题…"
          disabled={busy}
        />
        <button type="submit" className="tdw-button primary" disabled={busy || !draft.trim()}>
          发送
        </button>
      </form>
    </aside>
  )
}
