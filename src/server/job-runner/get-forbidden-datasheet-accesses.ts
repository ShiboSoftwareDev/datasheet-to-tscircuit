import type { TrustedAgentEvent } from "../agent-event-protocol"
import { stringifyForLog } from "./render-trusted-agent-event"

function getBashCommand(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined
  const command = (args as Record<string, unknown>).command
  return typeof command === "string" ? command : undefined
}

function stripSafeDatasheetExclusions(command: string): string {
  const find_exclusion =
    /(?:!\s*|-not\s+)-(?:name|path)\s+(?:"(?:\.\/)?datasheet\.(?:pdf|txt)"|'(?:\.\/)?datasheet\.(?:pdf|txt)'|(?:\.\/)?datasheet\.(?:pdf|txt))/gi
  const grep_exclusion =
    /--exclude(?:=|\s+)(?:"(?:\.\/)?datasheet\.(?:pdf|txt)"|'(?:\.\/)?datasheet\.(?:pdf|txt)'|(?:\.\/)?datasheet\.(?:pdf|txt))/gi
  const negative_glob =
    /(?:-g|--glob)(?:=|\s+)(?:"!(?:\.\/)?datasheet\.(?:pdf|txt)"|'!(?:\.\/)?datasheet\.(?:pdf|txt)'|!(?:\.\/)?datasheet\.(?:pdf|txt))/gi
  return command.replace(find_exclusion, "").replace(grep_exclusion, "").replace(negative_glob, "")
}

export function getForbiddenDatasheetAccesses(events: TrustedAgentEvent[]): string[] {
  const blocked = /(?:^|["'/\\])datasheet\.(?:pdf|txt)\b|\b(?:pdftotext|pdfinfo|pdftoppm|mutool|qpdf)\b/i
  return events.flatMap((event) => {
    if (event.type !== "tool_start") return []
    if (event.tool_name === "write") return []
    const rendered_args = stringifyForLog(event.args)
    const bash_command = event.tool_name === "bash" ? getBashCommand(event.args) : undefined
    const auditable_args = bash_command ? stripSafeDatasheetExclusions(bash_command) : rendered_args
    return blocked.test(auditable_args) ? [`${event.tool_name} ${rendered_args}`] : []
  })
}

export function assertNoDatasheetAccess(events: TrustedAgentEvent[], phase: string): void {
  const accesses = getForbiddenDatasheetAccesses(events)
  if (accesses.length > 0) {
    throw new Error(
      `${phase} accessed locked datasheet inputs after evidence approval: ${accesses.join("; ")}`,
    )
  }
}
