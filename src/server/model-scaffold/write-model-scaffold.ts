import { copyFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { modelWorkspaceInstructions } from "../instructions/model-workspace-instructions"
import { serverDirectory } from "../paths/repository-paths"
import { writeVisionRenderer } from "../vision-scaffold"

export async function writeModelScaffold(input: { job_dir: string; model_dir: string }): Promise<void> {
  await Promise.all([
    mkdir(join(input.model_dir, "benchmarks"), { recursive: true }),
    mkdir(join(input.model_dir, "evidence", "curves"), { recursive: true }),
    mkdir(join(input.model_dir, "models"), { recursive: true }),
    mkdir(join(input.model_dir, "results", "champion"), { recursive: true }),
  ])
  await Promise.all([
    copyFile(join(input.job_dir, "datasheet.pdf"), join(input.model_dir, "datasheet.pdf")),
    Bun.write(join(input.model_dir, "AGENTS.md"), modelWorkspaceInstructions),
    writeVisionRenderer(input.model_dir),
    Bun.write(
      join(input.model_dir, "score-benchmarks.ts"),
      `import { scoreModelBenchmarks } from ${JSON.stringify(
        pathToFileURL(join(serverDirectory, "model-scorer", "index.ts")).href,
      )}\n\nconst resultsDirectory = process.argv[2]\nconst outputFile = process.argv[3] ?? "validation-report.json"\nconst report = await scoreModelBenchmarks(process.cwd(), {\n  results_directory_override: resultsDirectory,\n})\nawait Bun.write(outputFile, \`${"${JSON.stringify(report, null, 2)}"}\\n\`)\nconsole.log(JSON.stringify(report, null, 2))\n`,
    ),
    Bun.write(
      join(input.model_dir, "score-benchmark.ts"),
      `import { mkdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseBenchmarkManifest, renderModelBenchmarkComparisonSvg, scoreSingleModelBenchmark } from ${JSON.stringify(
        pathToFileURL(join(serverDirectory, "model-scorer", "index.ts")).href,
      )}
import { extractSimulationResultSeries, parseSimulationDefinition } from ${JSON.stringify(
        pathToFileURL(join(serverDirectory, "model-simulation-validator", "index.ts")).href,
      )}

const benchmarkId = process.argv[2]
if (!benchmarkId) throw new Error("Usage: bun score-benchmark.ts <benchmark-id> [circuit-json-path]")
const modelDir = process.cwd()
const manifest = parseBenchmarkManifest(JSON.parse(await readFile(join(modelDir, "benchmarks.json"), "utf8")))
const benchmark = manifest.benchmarks.find((candidate) => candidate.id === benchmarkId)
if (!benchmark) throw new Error(\`Benchmark \${benchmarkId} was not found in benchmarks.json\`)
const circuitJsonPath = process.argv[3]
  ? resolve(process.argv[3])
  : join(dirname(modelDir), "dist", "spice", "benchmarks", benchmarkId, "circuit.json")
const circuitJson = JSON.parse(await readFile(circuitJsonPath, "utf8"))
const definitions = benchmark.series.map((series) => ({
  series_id: series.id,
  role: series.role,
  quantity: series.quantity,
  unit: series.unit,
  ...parseSimulationDefinition(series.simulation, { role: series.role, quantity: series.quantity }),
}))
const extracted = extractSimulationResultSeries(circuitJson, definitions)
const diagnosticDir = join(modelDir, "diagnostics", benchmarkId)
await mkdir(diagnosticDir, { recursive: true })
const resultFiles = Object.fromEntries(await Promise.all(benchmark.series.map(async (series) => {
  const resultFile = benchmark.series.length === 1 && series.id === "result"
    ? join(diagnosticDir, "result.csv")
    : join(diagnosticDir, "results", \`\${series.id}.csv\`)
  await mkdir(dirname(resultFile), { recursive: true })
  const points = extracted[series.id]
  await Bun.write(resultFile, \`x,y\\n\${points.map((point) => \`\${point.x},\${point.y}\`).join("\\n")}\\n\`)
  return [series.id, resultFile]
})))
const score = await scoreSingleModelBenchmark({ model_dir: modelDir, benchmark_id: benchmarkId, result_files_override: resultFiles })
const svg = await renderModelBenchmarkComparisonSvg({ model_dir: modelDir, benchmark_id: benchmarkId, result_files_override: resultFiles })
await Promise.all([
  Bun.write(join(diagnosticDir, "comparison.json"), \`\${JSON.stringify(score, null, 2)}\\n\`),
  Bun.write(join(diagnosticDir, "comparison.svg"), svg),
])
console.log(JSON.stringify({ ...score, circuit_json: circuitJsonPath, comparison_svg: join(diagnosticDir, "comparison.svg") }, null, 2))
`,
    ),
  ])
}
