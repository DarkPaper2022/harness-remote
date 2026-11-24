import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react"
import { api, type WorkspaceTerminalSummary } from "../api"
import type { ServerConfig } from "../types"
import { useTranslator } from "../useTranslator"

type Props = {
  config: ServerConfig
  directory: string
  projectName?: string
  interactionEnabled?: boolean
  onClose: () => void
}

type AnsiStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

type StyledSpan = {
  text: string
  style: AnsiStyle
}

type TerminalBufferState = {
  lines: StyledSpan[][]
  cursorLine: number
  cursorCol: number
  style: AnsiStyle
  carrySeq: string
}

const MAX_RENDERED_LINES = 800
const DRAWER_HEIGHT_KEY = "hr.terminal.drawerHeight"
const MIN_DRAWER_HEIGHT = 170
const MAX_DRAWER_HEIGHT = 620
const DEFAULT_DRAWER_HEIGHT = 270

const ANSI_PALETTE_16 = [
  "#18181b", "#ef4444", "#22c55e", "#eab308",
  "#3b82f6", "#a855f7", "#06b6d4", "#e4e4e7",
  "#71717a", "#f87171", "#4ade80", "#facc15",
  "#60a5fa", "#c084fc", "#22d3ee", "#fafafa"
]

function loadSavedDrawerHeight(): number {
  try {
    const raw = Number(localStorage.getItem(DRAWER_HEIGHT_KEY))
    if (Number.isFinite(raw) && raw >= MIN_DRAWER_HEIGHT && raw <= MAX_DRAWER_HEIGHT) {
      return Math.round(raw)
    }
  } catch {}
  return DEFAULT_DRAWER_HEIGHT
}

function ansi256Color(index: number): string | undefined {
  if (index < 0 || index > 255) return undefined
  if (index < 16) return ANSI_PALETTE_16[index]
  if (index < 232) {
    const cube = index - 16
    const r = Math.floor(cube / 36)
    const g = Math.floor((cube % 36) / 6)
    const b = cube % 6
    const channel = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`
  }
  const gray = 8 + (index - 232) * 10
  return `rgb(${gray}, ${gray}, ${gray})`
}

function applySgrCodes(current: AnsiStyle, rawParams: string): AnsiStyle {
  const parts = rawParams === "" ? [0] : rawParams.split(";").map((part) => (part === "" ? 0 : Number(part)))
  let next: AnsiStyle = { ...current }
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i]
    if (!Number.isFinite(code) || code === 0) {
      next = {}
    } else if (code === 1) {
      next.bold = true
    } else if (code === 2) {
      next.dim = true
    } else if (code === 3) {
      next.italic = true
    } else if (code === 4) {
      next.underline = true
    } else if (code === 22) {
      delete next.bold
      delete next.dim
    } else if (code === 23) {
      delete next.italic
    } else if (code === 24) {
      delete next.underline
    } else if (code >= 30 && code <= 37) {
      next.fg = ANSI_PALETTE_16[code - 30]
    } else if (code === 39) {
      delete next.fg
    } else if (code >= 40 && code <= 47) {
      next.bg = ANSI_PALETTE_16[code - 40]
    } else if (code === 49) {
      delete next.bg
    } else if (code >= 90 && code <= 97) {
      next.fg = ANSI_PALETTE_16[code - 90 + 8]
    } else if (code >= 100 && code <= 107) {
      next.bg = ANSI_PALETTE_16[code - 100 + 8]
    } else if (code === 38 || code === 48) {
      const isFg = code === 38
      const mode = parts[i + 1]
      if (mode === 5 && Number.isFinite(parts[i + 2])) {
        const color = ansi256Color(parts[i + 2])
        if (color) {
          if (isFg) next.fg = color
          else next.bg = color
        }
        i += 2
      } else if (mode === 2 && Number.isFinite(parts[i + 2]) && Number.isFinite(parts[i + 3]) && Number.isFinite(parts[i + 4])) {
        const color = `rgb(${parts[i + 2]}, ${parts[i + 3]}, ${parts[i + 4]})`
        if (isFg) next.fg = color
        else next.bg = color
        i += 4
      }
    }
  }
  return next
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg
    && a.bg === b.bg
    && Boolean(a.bold) === Boolean(b.bold)
    && Boolean(a.dim) === Boolean(b.dim)
    && Boolean(a.italic) === Boolean(b.italic)
    && Boolean(a.underline) === Boolean(b.underline)
  )
}

function createEmptyBuffer(): TerminalBufferState {
  return {
    lines: [[]],
    cursorLine: 0,
    cursorCol: 0,
    style: {},
    carrySeq: ""
  }
}

function lineLength(spans: StyledSpan[]): number {
  let len = 0
  for (const span of spans) len += span.text.length
  return len
}

function writeTextAtCursor(line: StyledSpan[], col: number, text: string, style: AnsiStyle): StyledSpan[] {
  if (!text) return line
  const currentLen = lineLength(line)
  if (col >= currentLen) {
    const pad = col > currentLen ? " ".repeat(col - currentLen) : ""
    const next = line.slice()
    if (pad) next.push({ text: pad, style: {} })
    const tail = next[next.length - 1]
    if (tail && sameStyle(tail.style, style)) {
      next[next.length - 1] = { text: tail.text + text, style: tail.style }
    } else {
      next.push({ text, style: { ...style } })
    }
    return next
  }

  // Overwrite characters starting at `col` (used after `\r` carriage returns / progress bars).
  const chars: Array<{ ch: string; style: AnsiStyle }> = []
  for (const span of line) {
    for (const ch of span.text) chars.push({ ch, style: span.style })
  }
  while (chars.length < col) chars.push({ ch: " ", style: {} })
  let pos = col
  for (const ch of text) {
    const cell = { ch, style: { ...style } }
    if (pos < chars.length) chars[pos] = cell
    else chars.push(cell)
    pos += 1
  }
  const merged: StyledSpan[] = []
  for (const cell of chars) {
    const last = merged[merged.length - 1]
    if (last && sameStyle(last.style, cell.style)) {
      last.text += cell.ch
    } else {
      merged.push({ text: cell.ch, style: cell.style })
    }
  }
  return merged
}

function truncateLineFrom(line: StyledSpan[], col: number): StyledSpan[] {
  if (col <= 0) return []
  const result: StyledSpan[] = []
  let remaining = col
  for (const span of line) {
    if (remaining <= 0) break
    if (span.text.length <= remaining) {
      result.push(span)
      remaining -= span.text.length
    } else {
      result.push({ text: span.text.slice(0, remaining), style: span.style })
      remaining = 0
    }
  }
  return result
}

function feedTerminalChunk(prev: TerminalBufferState, chunk: string): TerminalBufferState {
  const input = prev.carrySeq + chunk
  const lines = prev.lines.slice()
  let cursorLine = prev.cursorLine
  let cursorCol = prev.cursorCol
  let style = prev.style
  let carrySeq = ""

  let pendingText = ""
  const flushPending = () => {
    if (!pendingText) return
    while (lines.length <= cursorLine) lines.push([])
    lines[cursorLine] = writeTextAtCursor(lines[cursorLine], cursorCol, pendingText, style)
    cursorCol += pendingText.length
    pendingText = ""
  }

  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === "\x1b") {
      flushPending()
      if (i + 1 >= input.length) {
        carrySeq = input.slice(i)
        break
      }
      const next = input[i + 1]
      if (next === "[") {
        // CSI sequence: \x1b [ params intermediates finalByte (@..~)
        let j = i + 2
        while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x3f) {
          j += 1
        }
        if (j >= input.length) {
          carrySeq = input.slice(i)
          break
        }
        const params = input.slice(i + 2, j)
        const finalByte = input[j]
        if (finalByte === "m") {
          style = applySgrCodes(style, params)
        } else if (finalByte === "K") {
          while (lines.length <= cursorLine) lines.push([])
          const mode = Number(params || "0")
          if (mode === 2) {
            lines[cursorLine] = []
          } else if (mode === 0) {
            lines[cursorLine] = truncateLineFrom(lines[cursorLine], cursorCol)
          }
        } else if (finalByte === "J") {
          const mode = Number(params || "0")
          if (mode === 2 || mode === 3) {
            lines.length = 0
            lines.push([])
            cursorLine = 0
            cursorCol = 0
          } else if (mode === 0) {
            lines.length = cursorLine + 1
            lines[cursorLine] = truncateLineFrom(lines[cursorLine] || [], cursorCol)
          }
        } else if (finalByte === "H" || finalByte === "f") {
          if (!params || params === "1;1" || params === ";") {
            cursorCol = 0
          }
        } else if (finalByte === "G") {
          const col = Math.max(1, Number(params || "1"))
          cursorCol = col - 1
        } else if (finalByte === "C") {
          cursorCol += Math.max(1, Number(params || "1"))
        } else if (finalByte === "D") {
          cursorCol = Math.max(0, cursorCol - Math.max(1, Number(params || "1")))
        }
        i = j + 1
        continue
      }
      if (next === "]") {
        // OSC sequence: terminated by BEL (\x07) or ST (\x1b\\)
        let j = i + 2
        let foundEnd = false
        while (j < input.length) {
          if (input[j] === "\x07") {
            j += 1
            foundEnd = true
            break
          }
          if (input[j] === "\x1b" && input[j + 1] === "\\") {
            j += 2
            foundEnd = true
            break
          }
          j += 1
        }
        if (!foundEnd) {
          if (input.length - i < 512) {
            carrySeq = input.slice(i)
            break
          }
        }
        i = j
        continue
      }
      // Two-byte ESC sequence (e.g., ESC =, ESC >, ESC c)
      if (next === "c") {
        lines.length = 0
        lines.push([])
        cursorLine = 0
        cursorCol = 0
        style = {}
      }
      i += 2
      continue
    }

    if (ch === "\r") {
      flushPending()
      cursorCol = 0
      i += 1
      continue
    }
    if (ch === "\n") {
      flushPending()
      cursorLine += 1
      cursorCol = 0
      while (lines.length <= cursorLine) lines.push([])
      i += 1
      continue
    }
    if (ch === "\x08") {
      flushPending()
      cursorCol = Math.max(0, cursorCol - 1)
      i += 1
      continue
    }
    if (ch === "\x0c") {
      flushPending()
      lines.length = 0
      lines.push([])
      cursorLine = 0
      cursorCol = 0
      i += 1
      continue
    }
    if (ch === "\x07" || ch.charCodeAt(0) < 0x20 && ch !== "\t") {
      i += 1
      continue
    }
    if (ch === "\t") {
      const spaces = 8 - ((cursorCol + pendingText.length) % 8)
      pendingText += " ".repeat(spaces)
      i += 1
      continue
    }

    pendingText += ch
    i += 1
  }

  flushPending()

  if (lines.length > MAX_RENDERED_LINES) {
    const excess = lines.length - MAX_RENDERED_LINES
    lines.splice(0, excess)
    cursorLine = Math.max(0, cursorLine - excess)
  }

  return { lines, cursorLine, cursorCol, style, carrySeq }
}

function plainTextFromBuffer(buffer: TerminalBufferState): string {
  return buffer.lines
    .map((line) => line.map((span) => span.text).join(""))
    .join("\n")
}

export function TerminalDrawer({
  config,
  directory,
  projectName,
  interactionEnabled = true,
  onClose
}: Props) {
  const t = useTranslator()
  const isZh = t("nav.settings") === "设置"
  const [terminals, setTerminals] = useState<WorkspaceTerminalSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [commandInput, setCommandInput] = useState("")
  const [drawerHeight, setDrawerHeight] = useState<number>(loadSavedDrawerHeight)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [bufferRevision, setBufferRevision] = useState(0)

  const buffersRef = useRef<Map<string, TerminalBufferState>>(new Map())
  const nextSeqRef = useRef<Map<string, number>>(new Map())
  const viewportRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const stickToBottomRef = useRef(true)

  const endpointKey = `${config.host}:${config.port}:${directory}`

  const ensureBuffer = useCallback((id: string): TerminalBufferState => {
    const existing = buffersRef.current.get(id)
    if (existing) return existing
    const fresh = createEmptyBuffer()
    buffersRef.current.set(id, fresh)
    return fresh
  }, [])

  const estimateGridSize = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect || rect.width < 120) return { cols: 100, rows: 26 }
    const cols = Math.max(40, Math.min(240, Math.floor((rect.width - 28) / 7.8)))
    const rows = Math.max(8, Math.min(80, Math.floor((rect.height - 20) / 18)))
    return { cols, rows }
  }, [])

  const createNewTerminal = useCallback(async () => {
    if (!interactionEnabled || creating) return
    setCreating(true)
    setError(null)
    try {
      const { cols, rows } = estimateGridSize()
      const created = await api.createTerminal(config, { directory, cols, rows })
      let buf = createEmptyBuffer()
      for (const chunk of created.chunks) {
        buf = feedTerminalChunk(buf, chunk.data)
      }
      buffersRef.current.set(created.terminal.id, buf)
      nextSeqRef.current.set(created.terminal.id, created.nextSeq)
      setTerminals((prev) => {
        const filtered = prev.filter((item) => item.id !== created.terminal.id)
        return [...filtered, created.terminal]
      })
      setActiveId(created.terminal.id)
      setBufferRevision((rev) => rev + 1)
      stickToBottomRef.current = true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }, [config, creating, directory, estimateGridSize, interactionEnabled])

  // Discover existing terminals for this directory on mount / directory switch, or auto-spawn one.
  useEffect(() => {
    if (!interactionEnabled) return
    let cancelled = false
    setError(null)
    void (async () => {
      try {
        const { terminals: existing } = await api.listTerminals(config, directory)
        if (cancelled) return
        if (existing.length > 0) {
          setTerminals(existing)
          const preferred = existing.find((item) => item.status === "running") ?? existing[existing.length - 1]
          setActiveId((current) => (current && existing.some((item) => item.id === current) ? current : preferred.id))
          return
        }
        const { cols, rows } = estimateGridSize()
        const created = await api.createTerminal(config, { directory, cols, rows })
        if (cancelled) return
        let buf = createEmptyBuffer()
        for (const chunk of created.chunks) {
          buf = feedTerminalChunk(buf, chunk.data)
        }
        buffersRef.current.set(created.terminal.id, buf)
        nextSeqRef.current.set(created.terminal.id, created.nextSeq)
        setTerminals([created.terminal])
        setActiveId(created.terminal.id)
        setBufferRevision((rev) => rev + 1)
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [endpointKey, interactionEnabled])

  // Long-poll active terminal output for instant streaming across web, Capacitor iOS/Android, and Electron IPC.
  useEffect(() => {
    if (!activeId || !interactionEnabled) return
    let cancelled = false
    let retryTimer: number | undefined

    const loop = async () => {
      while (!cancelled) {
        const since = nextSeqRef.current.get(activeId) ?? 0
        try {
          const snap = await api.pollTerminal(config, activeId, since, since > 0 ? 8_000 : 0)
          if (cancelled) return
          if (snap.reset) {
            buffersRef.current.set(activeId, createEmptyBuffer())
          }
          if (snap.chunks.length > 0) {
            let buf = ensureBuffer(activeId)
            for (const chunk of snap.chunks) {
              buf = feedTerminalChunk(buf, chunk.data)
            }
            buffersRef.current.set(activeId, buf)
            setBufferRevision((rev) => rev + 1)
          }
          nextSeqRef.current.set(activeId, snap.nextSeq)
          setTerminals((prev) => prev.map((item) => (item.id === activeId ? snap.terminal : item)))
          if (snap.terminal.status !== "running") {
            return
          }
        } catch (err: unknown) {
          if (cancelled) return
          const msg = err instanceof Error ? err.message : String(err)
          if (/not found|404/i.test(msg)) {
            setTerminals((prev) => prev.filter((item) => item.id !== activeId))
            return
          }
          await new Promise<void>((resolve) => {
            retryTimer = window.setTimeout(resolve, 1_500)
          })
        }
      }
    }

    void loop()
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [activeId, endpointKey, ensureBuffer, interactionEnabled])

  // Keep PTY window size synced when drawer height or viewport width changes.
  useEffect(() => {
    if (!activeId || !interactionEnabled) return
    const timer = window.setTimeout(() => {
      const { cols, rows } = estimateGridSize()
      void api.resizeTerminal(config, activeId, cols, rows).catch(() => undefined)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [activeId, drawerHeight, endpointKey, estimateGridSize, interactionEnabled])

  useEffect(() => {
    const el = viewportRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [bufferRevision, activeId])

  const sendRaw = useCallback(async (data: string) => {
    if (!activeId || !data) return
    setError(null)
    try {
      stickToBottomRef.current = true
      await api.writeTerminal(config, activeId, data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [activeId, config])

  const handleCloseTab = useCallback(async (id: string) => {
    try {
      await api.closeTerminal(config, id)
    } catch {}
    buffersRef.current.delete(id)
    nextSeqRef.current.delete(id)
    setTerminals((prev) => {
      const next = prev.filter((item) => item.id !== id)
      if (activeId === id) {
        setActiveId(next[next.length - 1]?.id ?? null)
      }
      if (next.length === 0) {
        onClose()
      }
      return next
    })
  }, [activeId, config, onClose])

  const handleClearBuffer = useCallback(() => {
    if (!activeId) return
    buffersRef.current.set(activeId, createEmptyBuffer())
    setBufferRevision((rev) => rev + 1)
    void sendRaw("\x0c")
  }, [activeId, sendRaw])

  const handleCopyOutput = useCallback(async () => {
    if (!activeId) return
    const text = plainTextFromBuffer(ensureBuffer(activeId))
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {}
  }, [activeId, ensureBuffer])

  const handleViewportKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!activeId) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      const selection = window.getSelection()?.toString()
      if (selection) return // Allow native copy when text is selected!
      if (event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        void sendRaw("\x03")
        return
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      return // Handled by onPaste
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      const code = event.key.toUpperCase().charCodeAt(0)
      if (code >= 64 && code <= 95) {
        event.preventDefault()
        void sendRaw(String.fromCharCode(code - 64))
        return
      }
    }
    const specialMap: Record<string, string> = {
      Enter: "\r",
      Backspace: "\x7f",
      Tab: "\t",
      Escape: "\x1b",
      ArrowUp: "\x1b[A",
      ArrowDown: "\x1b[B",
      ArrowRight: "\x1b[C",
      ArrowLeft: "\x1b[D",
      Home: "\x1b[H",
      End: "\x1b[F",
      Delete: "\x1b[3~"
    }
    if (specialMap[event.key]) {
      event.preventDefault()
      void sendRaw(specialMap[event.key])
      return
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
      event.preventDefault()
      void sendRaw(event.key)
    }
  }, [activeId, sendRaw])

  const startResizeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = drawerHeight
    const onMove = (move: globalThis.PointerEvent) => {
      const next = Math.max(MIN_DRAWER_HEIGHT, Math.min(MAX_DRAWER_HEIGHT, Math.round(startHeight + (startY - move.clientY))))
      setDrawerHeight(next)
      try { localStorage.setItem(DRAWER_HEIGHT_KEY, String(next)) } catch {}
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.removeProperty("cursor")
      document.body.style.removeProperty("user-select")
    }
    document.body.style.cursor = "row-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }, [drawerHeight])

  const activeTerminal = useMemo(
    () => terminals.find((item) => item.id === activeId) ?? null,
    [terminals, activeId]
  )
  const activeBuffer = useMemo(
    () => (activeId ? ensureBuffer(activeId) : createEmptyBuffer()),
    [activeId, bufferRevision, ensureBuffer]
  )

  return (
    <section
      className="hr-terminal-drawer"
      style={{ height: `${drawerHeight}px` }}
      aria-label={isZh ? "工作区终端" : "Workspace terminal"}
    >
      <div
        className="hr-terminal-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={isZh ? "调整终端高度" : "Resize terminal drawer"}
        onPointerDown={startResizeDrag}
      />

      <header className="hr-terminal-header">
        <div className="hr-terminal-tabs" role="tablist">
          {terminals.map((term) => (
            <div
              key={term.id}
              className={`hr-terminal-tab${term.id === activeId ? " active" : ""}${term.status === "exited" ? " exited" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={term.id === activeId}
                className="hr-terminal-tab-select"
                onClick={() => setActiveId(term.id)}
              >
                <i className={`hr-terminal-dot ${term.status}`} aria-hidden="true" />
                <span>{term.title}</span>
                <small>{term.shell}</small>
              </button>
              <button
                type="button"
                className="hr-terminal-tab-close"
                title={isZh ? "关闭此终端进程" : "Kill terminal"}
                aria-label={isZh ? `关闭 ${term.title}` : `Kill ${term.title}`}
                onClick={() => void handleCloseTab(term.id)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="hr-terminal-icon-btn"
            disabled={!interactionEnabled || creating}
            onClick={() => void createNewTerminal()}
            title={isZh ? "新建终端标签页" : "New terminal"}
            aria-label={isZh ? "新建终端" : "New terminal"}
          >
            +
          </button>
        </div>

        <div className="hr-terminal-meta">
          <code title={directory}>{projectName || directory}</code>
          <button
            type="button"
            className="hr-terminal-action-btn"
            onClick={() => void handleCopyOutput()}
            title={isZh ? "复制终端文本" : "Copy output"}
          >
            {copied ? (isZh ? "已复制" : "Copied") : (isZh ? "复制" : "Copy")}
          </button>
          <button
            type="button"
            className="hr-terminal-action-btn"
            onClick={handleClearBuffer}
            title={isZh ? "清屏 (Ctrl+L)" : "Clear screen (Ctrl+L)"}
          >
            {isZh ? "清屏" : "Clear"}
          </button>
          <button
            type="button"
            className="hr-terminal-action-btn"
            onClick={onClose}
            title={isZh ? "收起终端面板 (后台保持运行)" : "Hide terminal drawer (keeps shell running)"}
          >
            {isZh ? "收起" : "Hide"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="hr-terminal-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>×</button>
        </div>
      ) : null}

      <div
        ref={viewportRef}
        className="hr-terminal-viewport"
        tabIndex={0}
        role="log"
        aria-live="off"
        onKeyDown={handleViewportKeyDown}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain")
          if (text) {
            event.preventDefault()
            void sendRaw(text)
          }
        }}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 36
        }}
      >
        {activeBuffer.lines.map((line, lineIdx) => {
          const isCursorLine = activeTerminal?.status === "running" && lineIdx === activeBuffer.cursorLine
          return (
            <div className="hr-terminal-line" key={lineIdx}>
              {line.length === 0 ? "\u00a0" : line.map((span, spanIdx) => (
                <span
                  key={spanIdx}
                  style={{
                    color: span.style.fg,
                    backgroundColor: span.style.bg,
                    fontWeight: span.style.bold ? 600 : undefined,
                    opacity: span.style.dim ? 0.68 : undefined,
                    fontStyle: span.style.italic ? "italic" : undefined,
                    textDecoration: span.style.underline ? "underline" : undefined
                  }}
                >
                  {span.text}
                </span>
              ))}
              {isCursorLine ? <span className="hr-terminal-cursor" aria-hidden="true" /> : null}
            </div>
          )
        })}
        {activeTerminal?.status === "exited" ? (
          <div className="hr-terminal-exit-banner">
            <span>
              {isZh
                ? `进程已退出 (code ${activeTerminal.exitCode ?? 0})`
                : `Process exited with code ${activeTerminal.exitCode ?? 0}`}
            </span>
            <button type="button" onClick={() => void createNewTerminal()}>
              {isZh ? "重新开启终端" : "Restart shell"}
            </button>
          </div>
        ) : null}
      </div>

      <form
        className="hr-terminal-input-bar"
        onSubmit={(event) => {
          event.preventDefault()
          void sendRaw(`${commandInput}\r`)
          setCommandInput("")
        }}
      >
        <div className="hr-terminal-quick-keys" aria-label={isZh ? "终端快捷键" : "Terminal quick keys"}>
          <button type="button" onClick={() => void sendRaw("\x03")} title="SIGINT (Ctrl+C)">Ctrl+C</button>
          <button type="button" onClick={() => void sendRaw("\t")} title="Autocomplete (Tab)">Tab</button>
          <button type="button" onClick={() => void sendRaw("\x1b[A")} title="Previous command">↑</button>
          <button type="button" onClick={() => void sendRaw("\x1b[B")} title="Next command">↓</button>
          <button type="button" onClick={() => void sendRaw("\x04")} title="EOF (Ctrl+D)">Ctrl+D</button>
        </div>
        <span className="hr-terminal-prompt-glyph" aria-hidden="true">❯</span>
        <input
          ref={inputRef}
          type="text"
          value={commandInput}
          disabled={!activeTerminal || activeTerminal.status !== "running"}
          onChange={(event) => setCommandInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              event.preventDefault()
              if (commandInput) {
                void sendRaw(`${commandInput}\t`)
                setCommandInput("")
              } else {
                void sendRaw("\t")
              }
            } else if (event.key === "ArrowUp" && !commandInput) {
              event.preventDefault()
              void sendRaw("\x1b[A")
            } else if (event.key === "ArrowDown" && !commandInput) {
              event.preventDefault()
              void sendRaw("\x1b[B")
            } else if (event.ctrlKey && event.key.toLowerCase() === "c" && !commandInput) {
              event.preventDefault()
              void sendRaw("\x03")
            }
          }}
          placeholder={
            isZh
              ? "输入命令回车执行（或点击上方黑色终端区域直接交互按键）…"
              : "Type command & press Enter (or click terminal above for direct keystrokes)…"
          }
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="submit"
          className="hr-terminal-send-btn"
          disabled={!activeTerminal || activeTerminal.status !== "running"}
        >
          {isZh ? "执行" : "Run"}
        </button>
      </form>
    </section>
  )
}
