import { readFile } from "node:fs/promises"
import type { JobLog } from "@/shared/job-types"
import {
  capRecentLogs,
  getLogArchivePath,
  readBoundedUtf8Tail,
} from "../infrastructure/persistence/bounded-log"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function readJson(file_path: string): Promise<unknown> {
  return readFile(file_path, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
}

export async function readPersistedLogs(file_path: string): Promise<JobLog[]> {
  const [archive_text, current_text] = await Promise.all([
    readBoundedUtf8Tail(getLogArchivePath(file_path)).catch(() => ""),
    readBoundedUtf8Tail(file_path).catch(() => ""),
  ])
  const deduplicated = new Map<string, JobLog>()
  for (const log of [...parseLogText(archive_text), ...parseLogText(current_text)]) {
    if (deduplicated.has(log.log_id)) deduplicated.delete(log.log_id)
    deduplicated.set(log.log_id, log)
  }
  return capRecentLogs([...deduplicated.values()])
}

function parseLogText(text: string): JobLog[] {
  const lines = text.split("\n")
  const first_ndjson_line = lines.findIndex((line) => parseLogLine(line) !== undefined)
  if (first_ndjson_line >= 0) {
    const legacy_prefix = lines.slice(0, first_ndjson_line).join("\n")
    return [
      ...readLegacyLogs(legacy_prefix),
      ...lines.slice(first_ndjson_line).flatMap((line) => {
        const log = parseLogLine(line)
        return log ? [log] : []
      }),
    ]
  }
  return readLegacyLogs(text)
}

function parseLogLine(line: string): JobLog | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    typeof value.log_id !== "string" ||
    typeof value.created_at !== "string" ||
    (value.stream !== "system" && value.stream !== "stdout" && value.stream !== "stderr") ||
    typeof value.message !== "string"
  ) {
    return undefined
  }
  return {
    log_id: value.log_id,
    created_at: value.created_at,
    stream: value.stream,
    message: value.message,
  }
}

function readLegacyLogs(text: string): JobLog[] {
  const expression = /^\[([^\]]+)] \[(system|stdout|stderr)] /gm
  const matches = [...text.matchAll(expression)]
  return matches.map((match, index) => {
    const message_start = (match.index ?? 0) + match[0].length
    const message_end = matches[index + 1]?.index ?? text.length
    return {
      log_id: `restored-${index}-${match[1] ?? "unknown"}`,
      created_at: match[1] ?? new Date(0).toISOString(),
      stream: match[2] as JobLog["stream"],
      message: text.slice(message_start, message_end),
    }
  })
}
