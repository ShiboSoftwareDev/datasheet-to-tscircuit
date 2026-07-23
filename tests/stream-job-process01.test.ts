import { expect, test } from "bun:test"
import { streamProcess } from "@/server/job-runner/stream-job-process"
import { streamModelProcess } from "@/server/model-runner/stream-model-process"

test("job toolchains use the development JSX runtime", async () => {
  let stdout = ""
  const exit_code = await streamProcess({
    command: [process.execPath, "-e", 'process.stdout.write(process.env.NODE_ENV ?? "unset")'],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    on_chunk: async (stream, message) => {
      if (stream === "stdout") stdout += message
    },
  })

  expect(exit_code).toBe(0)
  expect(stdout).toBe("development")
})

test("SPICE and benchmark toolchains use the development JSX runtime", async () => {
  let stdout = ""
  const exit_code = await streamModelProcess({
    command: [process.execPath, "-e", 'process.stdout.write(process.env.NODE_ENV ?? "unset")'],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    on_chunk: async (stream, message) => {
      if (stream === "stdout") stdout += message
    },
  })

  expect(exit_code).toBe(0)
  expect(stdout).toBe("development")
})
