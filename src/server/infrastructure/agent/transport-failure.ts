export function isTransientAgentTransportFailure(output: string): boolean {
  return /connection (?:was )?(?:error|closed|failed|lost|reset|terminated)|connection termination|failed to connect|unable to connect|econn(?:reset|refused|aborted)|network error|socket hang up|websocket (?:was )?(?:closed|failed|lost)|upstream connect error|disconnect\/reset before headers|fetch failed|temporarily unavailable|service unavailable|gateway timeout|internal server error|server had an error processing your request|["']server_error["']|too many concurrent requests|rate limit(?:ed| exceeded)?|http (?:429|502|503|504)\b|was there a typo in the (?:url|host) or port/i.test(
    output,
  )
}
