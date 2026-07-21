import { isAbsolute, join, relative, resolve, sep } from "node:path"

interface JobFileMetadata {
  download_name: string
  content_type: string
}

interface StaticJobFile extends JobFileMetadata {
  relative_path: string
}

type JobFileResolution =
  | { status: "invalid" }
  | { status: "missing"; download_name: string }
  | {
      status: "ready"
      artifact_path: string
      download_name: string
      content_type: string
    }

const static_job_files = {
  component: {
    relative_path: "index.circuit.tsx",
    download_name: "index.circuit.tsx",
    content_type: "text/typescript; charset=utf-8",
  },
  typical_application: {
    relative_path: "typical-application.circuit.tsx",
    download_name: "typical-application.circuit.tsx",
    content_type: "text/typescript; charset=utf-8",
  },
  log: {
    relative_path: "agent.log",
    download_name: "agent.log",
    content_type: "text/plain; charset=utf-8",
  },
  component_evidence: {
    relative_path: "component-evidence.json",
    download_name: "component-evidence.json",
    content_type: "application/json; charset=utf-8",
  },
  footprint_plan: {
    relative_path: "footprint-plan.json",
    download_name: "footprint-plan.json",
    content_type: "application/json; charset=utf-8",
  },
  application_plan: {
    relative_path: "typical-application-plan.json",
    download_name: "typical-application-plan.json",
    content_type: "application/json; charset=utf-8",
  },
  land_pattern: {
    relative_path: "visual-reference/land-pattern.png",
    download_name: "land-pattern.png",
    content_type: "image/png",
  },
  application_reference: {
    relative_path: "visual-reference/typical-application.png",
    download_name: "typical-application.png",
    content_type: "image/png",
  },
  events: {
    relative_path: "agent-events.jsonl",
    download_name: "agent-events.jsonl",
    content_type: "application/x-ndjson; charset=utf-8",
  },
} as const satisfies Record<string, StaticJobFile>

const component_schematic_reference: JobFileMetadata = {
  download_name: "component-schematic-reference.png",
  content_type: "image/png",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getPinoutImageCandidates(evidence: unknown): string[] {
  if (!isRecord(evidence) || !isRecord(evidence.pinout) || !Array.isArray(evidence.pinout.pins)) return []

  const image_counts = new Map<string, number>()
  for (const pin of evidence.pinout.pins) {
    if (!isRecord(pin) || !Array.isArray(pin.sources)) continue
    for (const source of pin.sources) {
      if (!isRecord(source) || typeof source.image !== "string") continue
      if (!source.image.startsWith("visual-reference/") || !source.image.toLowerCase().endsWith(".png")) {
        continue
      }
      image_counts.set(source.image, (image_counts.get(source.image) ?? 0) + 1)
    }
  }

  return [...image_counts]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([image_path]) => image_path)
}

function resolveVisualReference(job_dir: string, image_path: string): string | undefined {
  const visual_reference_dir = resolve(job_dir, "visual-reference")
  const artifact_path = resolve(job_dir, image_path)
  const artifact_relative_path = relative(visual_reference_dir, artifact_path)
  if (
    artifact_relative_path === "" ||
    artifact_relative_path === ".." ||
    artifact_relative_path.startsWith(`..${sep}`) ||
    isAbsolute(artifact_relative_path)
  ) {
    return undefined
  }
  return artifact_path
}

async function findComponentSchematicReference(job_dir: string): Promise<string | undefined> {
  const evidence = await Bun.file(join(job_dir, "component-evidence.json"))
    .json()
    .catch(() => undefined)
  for (const image_path of getPinoutImageCandidates(evidence)) {
    const artifact_path = resolveVisualReference(job_dir, image_path)
    if (artifact_path && Bun.file(artifact_path).size > 0) return artifact_path
  }
  return undefined
}

export async function resolveJobFileArtifact(
  job_dir: string,
  file_kind: string | null,
): Promise<JobFileResolution> {
  let descriptor: JobFileMetadata
  let artifact_path: string | undefined

  if (file_kind === "component_schematic_reference") {
    descriptor = component_schematic_reference
    artifact_path = await findComponentSchematicReference(job_dir)
  } else if (file_kind && file_kind in static_job_files) {
    const static_file = static_job_files[file_kind as keyof typeof static_job_files]
    descriptor = static_file
    artifact_path = join(job_dir, static_file.relative_path)
  } else {
    return { status: "invalid" }
  }

  if (!artifact_path || Bun.file(artifact_path).size === 0) {
    return { status: "missing", download_name: descriptor.download_name }
  }

  return {
    status: "ready",
    artifact_path,
    download_name: descriptor.download_name,
    content_type: descriptor.content_type,
  }
}
