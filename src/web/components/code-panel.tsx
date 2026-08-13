import { Check, Clipboard, Code2, Download } from "lucide-react"
import { useState } from "react"
import type { Job } from "@/shared/job-types"
import { getJobFileUrl } from "../api"

export function CodePanel({
  job,
  artifact = "component",
  local_run_id,
  application_id,
}: {
  job: Job
  artifact?: "component" | "typical_application"
  local_run_id?: string
  application_id?: string
}) {
  const [is_copied, setIsCopied] = useState(false)
  const code =
    artifact === "component"
      ? job.component_code
      : (job.typical_applications?.applications.find(
          (application) => application.application_id === application_id,
        )?.code ?? job.typical_application_code)
  if (!code) return null
  const file_name =
    artifact === "component"
      ? "index.circuit.tsx"
      : application_id && application_id !== "reference"
        ? `typical-application-${application_id}.circuit.tsx`
        : "typical-application.circuit.tsx"

  const copyCode = async () => {
    await navigator.clipboard.writeText(code)
    setIsCopied(true)
    window.setTimeout(() => setIsCopied(false), 1500)
  }

  return (
    <div className="code-tab-content">
      <header className="card-toolbar">
        <div className="toolbar-title">
          <Code2 size={16} />
          <span>{file_name}</span>
        </div>
        <div className="code-actions">
          <button type="button" onClick={copyCode}>
            {is_copied ? <Check size={14} /> : <Clipboard size={14} />}
            {is_copied ? "Copied" : "Copy"}
          </button>
          <a
            href={getJobFileUrl(job.job_id, artifact, {
              local_run_id,
              ...(application_id ? { application_id } : {}),
            })}
          >
            <Download size={14} /> Download
          </a>
        </div>
      </header>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}
