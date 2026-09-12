export type TailRefreshWork = () => Promise<void>

/**
 * Serialize authoritative transcript-tail reads and retain one trailing read when events arrive
 * while a read is already in flight. The pending slot always keeps the newest work item, so a burst
 * of streamed chunks becomes at most one extra authoritative read instead of either overlapping
 * loads or silently dropping the final event.
 * Preserved (manual) reads run individually and settle their own promise, so visible feedback does
 * not wait for the stream to become quiet and a manual failure does not reject background callers.
 */
export function createCoalescedTailRefresh(): (work: TailRefreshWork, preserve?: boolean) => Promise<void> {
  let pending: TailRefreshWork | null = null
  const explicit: TailRefreshWork[] = []
  let drainPromise: Promise<void> | null = null

  return function refresh(work: TailRefreshWork, preserve = false): Promise<void> {
    // A manual read owns visible feedback and must not be replaced by a later stream event.
    const completion = preserve ? new Promise<void>((resolve, reject) => {
      explicit.push(async () => {
        try { await work(); resolve() } catch (error) { reject(error) }
      })
    }) : null
    if (!preserve) pending = work
    if (!drainPromise) {
      drainPromise = (async () => {
        let firstFailure: unknown
        while (pending || explicit.length) {
          let next: TailRefreshWork
          if (explicit.length) next = explicit.shift()!
          else { next = pending!; pending = null }
          try {
            await next()
          } catch (error) {
            if (firstFailure === undefined) firstFailure = error
          }
        }
        if (firstFailure !== undefined) throw firstFailure
      })().finally(() => {
        drainPromise = null
      })
    }
    return completion ?? drainPromise
  }
}
