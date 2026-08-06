import { useEffect, useRef, useState } from "react"
import type { ModelRun, ModelRunEvent } from "@/shared/job-types"
import {
  cancelModelRun as cancelModelRunRequest,
  createModelRun,
  extendModelRun,
  getModelRun,
  retryModelRun,
} from "./api"

function parseEvent(message: MessageEvent<string>): ModelRunEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(message.data)
    if (typeof parsed !== "object" || parsed === null || !("event_type" in parsed)) return undefined
    return parsed as ModelRunEvent
  } catch {
    return undefined
  }
}

export function useModelRun(job_id?: string, local_run_id?: string) {
  const [model_run, setModelRun] = useState<ModelRun>()
  const [is_loading, setIsLoading] = useState(false)
  const [is_starting, setIsStarting] = useState(false)
  const [is_extending, setIsExtending] = useState(false)
  const [is_cancelling, setIsCancelling] = useState(false)
  const [is_retrying, setIsRetrying] = useState(false)
  const [error_message, setErrorMessage] = useState<string>()
  const event_source_ref = useRef<EventSource | undefined>(undefined)

  const connectToEvents = (target_job_id: string) => {
    event_source_ref.current?.close()
    const event_source = new EventSource(`/api/model-run/events?job_id=${encodeURIComponent(target_job_id)}`)
    event_source_ref.current = event_source
    event_source.onmessage = (message) => {
      const event = parseEvent(message)
      if (!event) return
      if (event.event_type === "log") {
        setModelRun((current_run) =>
          !current_run || current_run.logs.some((log) => log.log_id === event.log.log_id)
            ? current_run
            : { ...current_run, logs: [...current_run.logs, event.log] },
        )
      } else {
        setModelRun(event.model_run)
        if (event.model_run.is_complete) event_source.close()
      }
    }
  }

  useEffect(() => {
    setModelRun(undefined)
    setErrorMessage(undefined)
    if (!job_id) return
    let is_active = true
    setIsLoading(true)

    getModelRun(job_id, local_run_id)
      .then((loaded_run) => {
        if (!is_active) return
        setModelRun(loaded_run)
        setIsLoading(false)
        if (!loaded_run) return
        if (!local_run_id) connectToEvents(job_id)
      })
      .catch((error: Error) => {
        if (is_active) {
          setErrorMessage(error.message)
          setIsLoading(false)
        }
      })

    return () => {
      is_active = false
      event_source_ref.current?.close()
      event_source_ref.current = undefined
    }
  }, [job_id, local_run_id])

  const start = async (effort_multiplier: number) => {
    if (!job_id || local_run_id || is_starting) return
    setIsStarting(true)
    setErrorMessage(undefined)
    try {
      setModelRun(await createModelRun(job_id, effort_multiplier))
      connectToEvents(job_id)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The SPICE model run could not start.")
    } finally {
      setIsStarting(false)
    }
  }

  const extend = async (additional_effort: number) => {
    if (!job_id || local_run_id || is_extending) return
    setIsExtending(true)
    setErrorMessage(undefined)
    try {
      const next_run = await extendModelRun(job_id, additional_effort)
      setModelRun(next_run)
      if (!next_run.is_complete) connectToEvents(job_id)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "More effort could not be added.")
    } finally {
      setIsExtending(false)
    }
  }

  const cancel = async () => {
    if (!job_id || local_run_id || is_cancelling) return
    setIsCancelling(true)
    setErrorMessage(undefined)
    try {
      setModelRun(await cancelModelRunRequest(job_id))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The SPICE model run could not be stopped.")
    } finally {
      setIsCancelling(false)
    }
  }

  const retry = async () => {
    if (!job_id || local_run_id || is_retrying) return
    setIsRetrying(true)
    setErrorMessage(undefined)
    try {
      const next_run = await retryModelRun(job_id)
      setModelRun(next_run)
      connectToEvents(job_id)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The SPICE model run could not be retried.")
    } finally {
      setIsRetrying(false)
    }
  }

  return {
    model_run,
    is_loading,
    is_starting,
    is_extending,
    is_cancelling,
    is_retrying,
    error_message,
    local_run_id,
    is_read_only: Boolean(local_run_id),
    start,
    extend,
    cancel,
    retry,
  }
}
