export function captureAgentProcessOutput(current: string, message: string): string {
  return `${current}${message}`.slice(-16_000)
}

export function isTransientAgentTransportFailure(output: string): boolean {
  return /connection (?:was )?(?:error|closed|failed|lost|reset)|failed to connect|unable to connect|econn(?:reset|refused|aborted)|network error|socket hang up|fetch failed|temporarily unavailable|service unavailable|gateway timeout|http (?:502|503|504)\b|was there a typo in the (?:url|host) or port/i.test(
    output,
  )
}

export function summarizeAgentProcessFailure(output: string): string | undefined {
  const lines = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const diagnostic_lines = lines.filter((line) =>
    /(?:error:|connection|connect|network|socket|unavailable|gateway|timed out|timeout|url or port)/i.test(
      line,
    ),
  )
  const selected = diagnostic_lines.length > 0 ? diagnostic_lines.slice(-4) : lines.slice(-6)
  const unique = selected.filter((line, index) => selected.indexOf(line) === index)
  return unique.length > 0 ? unique.join(" | ").slice(-2_000) : undefined
}
