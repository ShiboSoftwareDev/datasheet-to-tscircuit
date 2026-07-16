import { ArrowRight, FileText, FlaskConical, Sparkles, UploadCloud, X } from "lucide-react"
import { useRef, useState } from "react"
import { createJob } from "../api"
import type { Job } from "@/shared/job-types"

const MODEL_ENABLED_STORAGE_KEY = "datasheet-create-pspice-model"
const MODEL_EFFORT_STORAGE_KEY = "datasheet-model-effort"

function getInitialModelEnabled(): boolean {
  try {
    const saved = window.localStorage.getItem(MODEL_ENABLED_STORAGE_KEY)
    return saved === null ? true : saved === "true"
  } catch {
    return true
  }
}

function getInitialModelEffort(): number {
  try {
    const saved = Number(window.localStorage.getItem(MODEL_EFFORT_STORAGE_KEY))
    return [1, 2, 4, 8].includes(saved) ? saved : 1
  } catch {
    return 1
  }
}

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
  const [create_pspice_model, setCreatePspiceModel] = useState(getInitialModelEnabled)
  const [model_effort, setModelEffort] = useState(getInitialModelEffort)
  const [is_uploading, setIsUploading] = useState(false)
  const [error_message, setErrorMessage] = useState<string>()

  const updateCreatePspiceModel = (is_enabled: boolean) => {
    setCreatePspiceModel(is_enabled)
    try {
      window.localStorage.setItem(MODEL_ENABLED_STORAGE_KEY, String(is_enabled))
    } catch {
      // The preference is optional when storage is unavailable.
    }
  }

  const updateModelEffort = (effort: number) => {
    setModelEffort(effort)
    try {
      window.localStorage.setItem(MODEL_EFFORT_STORAGE_KEY, String(effort))
    } catch {
      // The preference is optional when storage is unavailable.
    }
  }

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
      on_job_created(
        await createJob(file, additional_instructions, {
          create_pspice_model,
          model_effort_multiplier: model_effort,
        }),
      )
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

      <section className={`upload-model-option ${create_pspice_model ? "enabled" : ""}`}>
        <button
          className="model-option-toggle"
          type="button"
          role="switch"
          aria-checked={create_pspice_model}
          onClick={() => updateCreatePspiceModel(!create_pspice_model)}
        >
          <span className="model-option-icon">
            <FlaskConical size={17} />
          </span>
          <span className="model-option-copy">
            <strong>Create SPICE behavioral model</strong>
            <small>
              Validated with ngspice; evidence setup and benchmark locking run outside the refinement budget.
            </small>
          </span>
          <i aria-hidden="true">
            <b />
          </i>
        </button>

        <div
          className={`upload-effort-section ${create_pspice_model ? "is-visible" : "is-hidden"}`}
          aria-hidden={!create_pspice_model}
        >
          <span className="upload-effort-label">Effort:</span>
          <div className="effort-picker upload-effort-picker" role="group" aria-label="SPICE modeling effort">
            {[1, 2, 4, 8].map((value) => (
              <button
                className={model_effort === value ? "selected" : ""}
                type="button"
                key={value}
                disabled={!create_pspice_model}
                onClick={() => updateModelEffort(value)}
              >
                <strong>{value}×</strong>
                <small>{value === 1 ? "Baseline" : `${value}× time`}</small>
              </button>
            ))}
          </div>
        </div>
      </section>

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
            {create_pspice_model ? "Generate component + SPICE model" : "Generate component"}{" "}
            <ArrowRight size={18} />
          </>
        )}
      </button>
    </section>
  )
}
