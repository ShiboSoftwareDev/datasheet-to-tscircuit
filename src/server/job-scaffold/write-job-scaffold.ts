import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getPinnedTscircuitVersion } from "../runtime-versions"
import { writeVisionRenderer } from "../vision-scaffold"
import { STARTER_COMPONENT } from "./starter-component"
import { ensureJobTscircuitRuntimeConfig } from "./ensure-job-tscircuit-runtime-config"

export async function writeJobScaffold(job_dir: string): Promise<void> {
  const tscircuit_version = await getPinnedTscircuitVersion()
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "index.circuit.tsx"), STARTER_COMPONENT),
    writeVisionRenderer(job_dir),
    Bun.write(
      join(job_dir, "package.json"),
      `${JSON.stringify(
        {
          name: "generated-datasheet-component",
          private: true,
          type: "module",
          scripts: {
            build: "tsci build index.circuit.tsx",
            "build:component": "tsci build index.circuit.tsx",
            "build:application": "tsci build typical-application.circuit.tsx",
          },
          devDependencies: {
            "@resvg/resvg-js": "^2.6.2",
            "@tscircuit/ngspice-spice-engine": "^0.0.19",
            tscircuit: tscircuit_version,
          },
        },
        null,
        2,
      )}\n`,
    ),
    Bun.write(
      join(job_dir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            strict: true,
            noEmit: true,
            types: ["tscircuit"],
          },
          include: ["*.circuit.tsx"],
        },
        null,
        2,
      )}\n`,
    ),
    Bun.write(
      join(job_dir, "tscircuit.config.json"),
      `${JSON.stringify(
        {
          $schema: "https://cdn.jsdelivr.net/npm/@tscircuit/cli/types/tscircuit.config.schema.json",
        },
        null,
        2,
      )}\n`,
    ),
    ensureJobTscircuitRuntimeConfig(job_dir),
  ])
}
