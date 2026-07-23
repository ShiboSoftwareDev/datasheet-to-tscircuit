import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { repositoryRoot } from "../paths/repository-paths"

export function importsGeneratedComponent(source: string): boolean {
  return /\bfrom\s*["']\.\/index\.circuit(?:\.tsx)?["']/.test(source)
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? listFilesRecursively(path) : Promise.resolve([path])
    }),
  )
  return nested.flat().sort()
}

export async function snapshotProtectedTree(directory: string): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>()
  for (const path of await listFilesRecursively(directory)) {
    snapshot.set(relative(directory, path), await readFile(path))
  }
  return snapshot
}

export async function restoreProtectedTree(
  directory: string,
  snapshot: Map<string, Buffer>,
): Promise<boolean> {
  let modified = false
  const current_paths = await listFilesRecursively(directory)
  const current_relative_paths = new Set(current_paths.map((path) => relative(directory, path)))
  for (const path of current_paths) {
    const relative_path = relative(directory, path)
    if (snapshot.has(relative_path)) continue
    modified = true
    await rm(path, { force: true })
  }
  for (const [relative_path, expected] of snapshot) {
    const path = join(directory, relative_path)
    const current = current_relative_paths.has(relative_path)
      ? await readFile(path).catch(() => undefined)
      : undefined
    if (current?.equals(expected)) continue
    modified = true
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, expected)
  }
  return modified
}

type GenerationWorkspacePhase = "component" | "application"

interface GenerationWorkspace {
  directory: string
  protected_files: Map<string, Buffer>
  protected_visuals: Map<string, Buffer>
}

async function copyWorkspacePath(input: {
  source_root: string
  destination_root: string
  path: string
}): Promise<void> {
  const { source_root, destination_root, path } = input
  const destination = join(destination_root, path)
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(source_root, path), destination, { recursive: true }).catch(() => undefined)
}

export async function prepareGenerationWorkspace(
  job_dir: string,
  phase: GenerationWorkspacePhase,
): Promise<GenerationWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), `datasheet-${phase}-generation-`))
  const common_files = [
    "AGENTS.md",
    "package.json",
    "tsconfig.json",
    "tscircuit.config.json",
    "tscircuit.config.ts",
    "render-svg-to-png.ts",
    "index.circuit.tsx",
    "component-evidence.json",
    "component-schematic-plan.json",
    "footprint-plan.json",
    "typical-application-plan.json",
  ]
  const application_files = [
    "component.circuit.tsx",
    "typical-application.circuit.tsx",
    "dist/index",
    "build-targets.log",
  ]
  const visual_reference =
    phase === "component"
      ? join("visual-reference", "land-pattern.png")
      : join("visual-reference", "typical-application.png")
  for (const path of [
    ...common_files,
    ...(phase === "application" ? application_files : []),
    visual_reference,
  ]) {
    await copyWorkspacePath({ source_root: job_dir, destination_root: directory, path })
  }
  await symlink(resolve(repositoryRoot, "node_modules"), join(directory, "node_modules"), "dir")

  const protected_file_names = [
    "component-evidence.json",
    "component-schematic-plan.json",
    "footprint-plan.json",
    "typical-application-plan.json",
    ...(phase === "application" ? ["index.circuit.tsx", "component.circuit.tsx"] : []),
  ]
  const protected_files = new Map<string, Buffer>()
  for (const path of protected_file_names) {
    const contents = await readFile(join(directory, path)).catch(() => undefined)
    if (contents) protected_files.set(path, contents)
  }
  return {
    directory,
    protected_files,
    protected_visuals: await snapshotProtectedTree(join(directory, "visual-reference")),
  }
}

export async function generationWorkspaceWasModified(workspace: GenerationWorkspace): Promise<boolean> {
  for (const [path, expected] of workspace.protected_files) {
    const current = await readFile(join(workspace.directory, path)).catch(() => undefined)
    if (!current?.equals(expected)) return true
  }
  const current_visuals = await snapshotProtectedTree(join(workspace.directory, "visual-reference"))
  if (current_visuals.size !== workspace.protected_visuals.size) return true
  for (const [path, expected] of workspace.protected_visuals) {
    if (!current_visuals.get(path)?.equals(expected)) return true
  }
  return false
}

export async function publishGenerationWorkspace(input: {
  workspace: GenerationWorkspace
  job_dir: string
  phase: GenerationWorkspacePhase
}): Promise<void> {
  const { workspace, job_dir, phase } = input
  const outputs =
    phase === "component"
      ? ["index.circuit.tsx", "component-visual-inspection.json", "dist/index", "build-targets.log"]
      : [
          "typical-application.circuit.tsx",
          "application-visual-inspection.json",
          "dist/typical-application",
          "build-targets.log",
        ]
  for (const path of outputs) {
    const source = join(workspace.directory, path)
    if (!(await Bun.file(source).exists()) && !(await readdir(source).catch(() => undefined))) continue
    const destination = join(job_dir, path)
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true })
  }
}
