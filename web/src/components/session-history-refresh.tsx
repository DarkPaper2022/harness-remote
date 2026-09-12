import { useEffect, useRef, useState } from "react"
import { LoadingIcon, RefreshIcon } from "../Icons"
import { useTranslator } from "../useTranslator"
import "../session-history-refresh.css"

type Props = {
  onRefresh: () => Promise<void>
  disabled?: boolean
}

/** Explicitly refreshes the open Session transcript without disturbing the current messages. */
export function SessionHistoryRefresh({ onRefresh, disabled = false }: Props) {
  const t = useTranslator()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<"success" | "error" | null>(null)
  const timer = useRef<number | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  async function refresh() {
    if (inFlight.current || disabled) return
    inFlight.current = true
    if (timer.current !== null) window.clearTimeout(timer.current)
    setLoading(true)
    setStatus(null)
    try {
      await onRefresh()
      if (!mounted.current) return
      setStatus("success")
      timer.current = window.setTimeout(() => setStatus(null), 2400)
    } catch {
      // The existing transcript stays mounted; the caller can keep showing it while this error is visible.
      if (mounted.current) setStatus("error")
    } finally {
      inFlight.current = false
      if (mounted.current) setLoading(false)
    }
  }

  return (
    <div className="hr-session-history-refresh">
      <button
        type="button"
        className="tdw-icon-button hr-session-history-refresh-button"
        onClick={() => void refresh()}
        disabled={disabled || loading}
        aria-label={t(loading ? "sf.refreshingHistory" : "sf.refreshHistory")}
        title={t(loading ? "sf.refreshingHistory" : "sf.refreshHistory")}
        aria-busy={loading || undefined}
      >
        {loading ? <LoadingIcon size={17} /> : <RefreshIcon size={17} />}
      </button>
      {status === "success" ? <span className="hr-session-history-refresh-status" role="status">{t("sf.historyRefreshed")}</span> : null}
      {status === "error" ? <span className="hr-session-history-refresh-error" role="alert">{t("sf.refreshFailed")}</span> : null}
    </div>
  )
}
