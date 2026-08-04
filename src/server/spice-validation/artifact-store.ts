import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ValidationCaseResult, ValidationRunResult } from "./types"

export interface ValidationCaseArtifactPaths {
  directory: string
  circuit_path: string
  raw_path: string
}

/** Owns the stable, replayable validation/generated artifact layout. */
export class ValidationArtifactStore {
  readonly generated_directory: string

  constructor(model_directory: string, artifact_directory?: string) {
    this.generated_directory = artifact_directory ?? join(model_directory, "validation", "generated")
  }

  async prepareRun(model_source: string): Promise<void> {
    await mkdir(this.generated_directory, { recursive: true })
    await writeFile(join(this.generated_directory, "model.lib"), model_source, "utf8")
  }

  async prepareCase(case_id: string, netlist: string): Promise<ValidationCaseArtifactPaths> {
    const directory = join(this.generated_directory, case_id)
    const circuit_path = join(directory, "circuit.cir")
    const raw_path = join(directory, "result.raw")
    await mkdir(directory, { recursive: true })
    // A simulator failure must never make a rerun consume the preceding run's data.
    await rm(raw_path, { force: true })
    await Promise.all([
      writeFile(circuit_path, netlist, "utf8"),
      writeFile(join(directory, ".spiceinit"), "set filetype=ascii\n", "utf8"),
    ])
    return { directory, circuit_path, raw_path }
  }

  async writeProcessLogs(
    paths: ValidationCaseArtifactPaths,
    output: { stdout: string; stderr: string },
  ): Promise<void> {
    await Promise.all([
      writeFile(join(paths.directory, "stdout.log"), output.stdout, "utf8"),
      writeFile(join(paths.directory, "stderr.log"), output.stderr, "utf8"),
    ])
  }

  readRaw(paths: ValidationCaseArtifactPaths): Promise<string> {
    return readFile(paths.raw_path, "utf8")
  }

  async writeCaseResult(paths: ValidationCaseArtifactPaths, result: ValidationCaseResult): Promise<void> {
    await writeFile(join(paths.directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8")
  }

  async writeRunResult(result: ValidationRunResult): Promise<void> {
    await writeFile(
      join(this.generated_directory, "validation-results.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    )
  }
}
