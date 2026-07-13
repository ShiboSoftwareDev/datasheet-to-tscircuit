import { Check, Clipboard, Code2, Download } from "lucide-react"
import { useState } from "react"
import type { Job } from "@/shared/job-types"
import { getJobFileUrl } from "../api"

export function CodePanel({ job }: { job: Job }) {
  const [is_copied, setIsCopied] = useState(false)
  if (!job.component_code) return null

  const copyCode = async () => {
    await navigator.clipboard.writeText(job.component_code ?? "")
    setIsCopied(true)
    window.setTimeout(() => setIsCopied(false), 1500)
  }

  return (
    <div className="code-tab-content">
      <header className="card-toolbar">
        <div className="toolbar-title">
          <Code2 size={16} />
          <span>index.circuit.tsx</span>
        </div>
        <div className="code-actions">
          <button type="button" onClick={copyCode}>
            {is_copied ? <Check size={14} /> : <Clipboard size={14} />}
            {is_copied ? "Copied" : "Copy"}
          </button>
          <a href={getJobFileUrl(job.job_id, "component")}>
            <Download size={14} /> Download
          </a>
        </div>
      </header>
      <pre>
        <code>{job.component_code}</code>
      </pre>
    </div>
  )
}
