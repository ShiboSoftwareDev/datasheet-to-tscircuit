import { useEffect, useRef, useState } from "react"
import type { LocalRunDetail, LocalRunSummary } from "@/shared/local-run"
import { getLocalRun, getLocalRuns, rerunLocal } from "./api"

function upsertLocalRun(current: LocalRunSummary[], next: LocalRunSummary): LocalRunSummary[] {
  return [next, ...current.filter((run) => run.local_run_id !== next.local_run_id)].sort((first, second) =>
    second.created_at.localeCompare(first.created_at),
  )
}

export function useLocalRuns() {
  const initialLocalRunId = new URLSearchParams(window.location.search).get("local_run_id") ?? undefined
  const [local_runs, setLocalRuns] = useState<LocalRunSummary[]>([])
  const [active_local_run_id, setActiveLocalRunIdState] = useState<string | undefined>(initialLocalRunId)
  const [detail, setDetail] = useState<LocalRunDetail>()
  const [load_error, setLoadError] = useState<string>()
  const [action_error, setActionError] = useState<string>()
  const [rerunning_local_run_ids, setRerunningLocalRunIds] = useState<Set<string>>(new Set())
  const rerunningRef = useRef(new Set<string>())

  const mergeLocalRun = (run: LocalRunSummary) => {
    setLocalRuns((current) => upsertLocalRun(current, run))
  }

  useEffect(() => {
    let active = true
    const refresh = () => {
      void getLocalRuns()
        .then((runs) => {
          if (active) setLocalRuns(runs)
        })
        .catch((error: Error) => {
          if (active) setActionError(error.message)
        })
    }
    refresh()
    const interval = window.setInterval(refresh, 1_500)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (!active_local_run_id) {
      setDetail(undefined)
      setLoadError(undefined)
      return
    }
    let active = true
    const refresh = () => {
      void getLocalRun(active_local_run_id)
        .then((nextDetail) => {
          if (!active) return
          setDetail(nextDetail)
          setLoadError(undefined)
          mergeLocalRun(nextDetail.local_run)
        })
        .catch((error: Error) => {
          if (active) setLoadError(error.message)
        })
    }
    setDetail((current) => (current?.local_run.local_run_id === active_local_run_id ? current : undefined))
    setLoadError(undefined)
    refresh()
    const interval = window.setInterval(refresh, 1_500)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [active_local_run_id])

  const setActiveLocalRunId = (localRunId?: string) => {
    setActiveLocalRunIdState(localRunId)
    setDetail((current) => (current?.local_run.local_run_id === localRunId ? current : undefined))
    setLoadError(undefined)
    setActionError(undefined)
    const requestUrl = new URL(window.location.href)
    if (localRunId) requestUrl.searchParams.set("local_run_id", localRunId)
    else requestUrl.searchParams.delete("local_run_id")
    window.history.replaceState({}, "", requestUrl)
  }

  const selectLocalRun = (run: LocalRunSummary) => {
    mergeLocalRun(run)
    setActiveLocalRunId(run.local_run_id)
  }

  const runAgain = async (localRunId: string) => {
    if (rerunningRef.current.has(localRunId)) return
    rerunningRef.current.add(localRunId)
    setRerunningLocalRunIds((current) => new Set(current).add(localRunId))
    setActionError(undefined)
    try {
      const next = await rerunLocal(localRunId)
      selectLocalRun(next)
      return next
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The Local run could not start.")
    } finally {
      rerunningRef.current.delete(localRunId)
      setRerunningLocalRunIds((current) => {
        const next = new Set(current)
        next.delete(localRunId)
        return next
      })
    }
  }

  return {
    local_runs,
    active_local_run_id,
    detail,
    load_error,
    action_error,
    rerunning_local_run_ids,
    setActiveLocalRunId,
    selectLocalRun,
    runAgain,
  }
}
