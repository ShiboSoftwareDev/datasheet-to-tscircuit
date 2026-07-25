import * as Dialog from "@radix-ui/react-dialog"
import { TriangleAlert, X } from "lucide-react"

export function ArtifactWarningsDialog({
  warnings,
  artifact_label,
}: {
  warnings: string[]
  artifact_label: string
}) {
  if (warnings.length === 0) return null
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          className="workspace-warning-trigger"
          type="button"
          aria-label={`View ${warnings.length} ${artifact_label} warning${warnings.length === 1 ? "" : "s"}`}
          title={`${warnings.length} ${artifact_label} warning${warnings.length === 1 ? "" : "s"}`}
        >
          <TriangleAlert size={13} />
          <span className="workspace-warning-count">{warnings.length}</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="model-dialog-overlay" />
        <Dialog.Content className="model-dialog-content warning-dialog-content">
          <header>
            <div>
              <Dialog.Title>{artifact_label} warnings</Dialog.Title>
              <Dialog.Description>
                The output is available, but these checks need your attention.
              </Dialog.Description>
            </div>
            <div className="model-dialog-actions">
              <Dialog.Close asChild>
                <button type="button" aria-label="Close warnings">
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
          </header>
          <div className="warning-dialog-body">
            <ol>
              {warnings.map((warning) => (
                <li key={warning}>
                  <TriangleAlert size={16} />
                  <p>{warning}</p>
                </li>
              ))}
            </ol>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
