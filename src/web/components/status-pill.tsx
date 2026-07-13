import { Check, LoaderCircle, TriangleAlert } from "lucide-react"
import type { JobDisplayStatus } from "@/shared/job-types"

const STATUS_COPY: Record<JobDisplayStatus, string> = {
  queued: "Queued",
  agent_running: "Agent running",
  building: "Building preview",
  complete: "Component ready",
  failed: "Needs attention",
}

export function StatusPill({ display_status }: { display_status: JobDisplayStatus }) {
  const is_working =
    display_status === "queued" || display_status === "agent_running" || display_status === "building"
  const icon =
    display_status === "complete" ? (
      <Check size={13} strokeWidth={2.6} />
    ) : display_status === "failed" ? (
      <TriangleAlert size={13} />
    ) : (
      <LoaderCircle className={is_working ? "spin" : undefined} size={13} />
    )

  return (
    <span className={`status-pill status-${display_status}`}>
      {icon}
      {STATUS_COPY[display_status]}
    </span>
  )
}
