export type ProcessErrorCode =
  | "process_spawn_failed"
  | "process_exit_failed"
  | "process_output_handler_failed"
  | "process_idle_timeout"
  | "process_wall_timeout"
  | "process_cancelled"

export class ProcessError extends Error {
  readonly code: ProcessErrorCode
  readonly command_label: string
  readonly exit_code?: number
  readonly output_tail?: string

  constructor(input: {
    code: ProcessErrorCode
    command_label: string
    message: string
    exit_code?: number
    output_tail?: string
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "ProcessError"
    this.code = input.code
    this.command_label = input.command_label
    this.exit_code = input.exit_code
    this.output_tail = input.output_tail
  }
}
