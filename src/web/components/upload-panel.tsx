import { ArrowRight, FileText, ShieldCheck, Sparkles, UploadCloud, X } from "lucide-react"
import { useRef, useState } from "react"
import { createJob } from "../api"
import type { Job } from "@/shared/job-types"

interface UploadPanelProps {
  on_job_created: (job: Job) => void
}

function formatFileSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function UploadPanel({ on_job_created }: UploadPanelProps) {
  const input_ref = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File>()
  const [is_dragging, setIsDragging] = useState(false)
  const [additional_instructions, setAdditionalInstructions] = useState("")
  const [is_uploading, setIsUploading] = useState(false)
  const [error_message, setErrorMessage] = useState<string>()

  const selectFile = (next_file?: File) => {
    setErrorMessage(undefined)
    if (!next_file) return
    if (!next_file.name.toLowerCase().endsWith(".pdf")) {
      setErrorMessage("Please choose a PDF datasheet.")
      return
    }
    setFile(next_file)
  }

  const submit = async () => {
    if (!file || is_uploading) return
    setIsUploading(true)
    setErrorMessage(undefined)
    try {
      on_job_created(await createJob(file, additional_instructions))
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The upload could not be started.")
      setIsUploading(false)
    }
  }

  return (
    <section className="upload-panel" aria-labelledby="upload-title">
      <div className="upload-heading">
        <span className="eyebrow">
          <Sparkles size={14} /> AI component generator
        </span>
        <h1 id="upload-title">Turn a datasheet into a tscircuit component.</h1>
        <p>
          Upload a component PDF. The tscircuit agent reads the pinout and mechanical drawings, writes
          reusable TSX, then builds live schematic and PCB previews.
        </p>
      </div>

      <div
        className={`drop-zone ${is_dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragging(false)
          selectFile(event.dataTransfer.files[0])
        }}
      >
        <input
          ref={input_ref}
          data-testid="datasheet-input"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(event) => selectFile(event.target.files?.[0])}
        />
        {file ? (
          <div className="selected-file">
            <span className="file-icon">
              <FileText size={25} />
            </span>
            <span className="file-copy">
              <strong>{file.name}</strong>
              <small>{formatFileSize(file.size)} · ready to analyze</small>
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label="Remove selected PDF"
              onClick={() => setFile(undefined)}
            >
              <X size={18} />
            </button>
          </div>
        ) : (
          <button className="drop-zone-button" type="button" onClick={() => input_ref.current?.click()}>
            <span className="upload-icon">
              <UploadCloud size={29} />
            </span>
            <strong>Drop your datasheet here</strong>
            <span>or click to browse · PDF up to 30 MB</span>
          </button>
        )}
      </div>

      <label className="context-field">
        <span>
          Component context <small>optional</small>
        </span>
        <textarea
          value={additional_instructions}
          maxLength={4000}
          onChange={(event) => setAdditionalInstructions(event.target.value)}
          placeholder="Example: Use the QFN-24 package variant and expose the thermal pad as GND."
        />
      </label>

      {error_message && (
        <p className="form-error" role="alert">
          {error_message}
        </p>
      )}

      <button className="primary-button" type="button" disabled={!file || is_uploading} onClick={submit}>
        {is_uploading ? (
          <>
            <span className="button-spinner" /> Uploading datasheet…
          </>
        ) : (
          <>
            Generate component <ArrowRight size={18} />
          </>
        )}
      </button>

      <div className="trust-row">
        <span>
          <ShieldCheck size={15} /> Isolated job workspace
        </span>
        <span className="trust-dot" />
        <span>Every agent event is streamed</span>
      </div>
    </section>
  )
}
