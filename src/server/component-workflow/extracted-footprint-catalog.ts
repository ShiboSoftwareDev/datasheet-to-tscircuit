import { lstat, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  canonicalizeComponentEvidenceInput,
  parseComponentFootprintCatalog,
  type ComponentFootprintCatalog,
} from "../component-evidence"
import { readBoundedJsonArtifact } from "../infrastructure/artifacts"

const FOOTPRINT_FILE_PATTERN = /^component-footprints\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/
const MAX_FOOTPRINT_VARIANTS = 24

interface ExtractedFootprintCatalogIndex {
  version: 1
  default_footprint_id: string
  footprint_files: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort()
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`)
  }
}

function parseIndex(value: unknown): ExtractedFootprintCatalogIndex {
  const label = "extracted component footprint catalog"
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("component-footprint-catalog.json must be a version-1 extracted catalog index")
  }
  assertOnlyKeys(value, ["version", "default_footprint_id", "footprint_files"], label)
  if (typeof value.default_footprint_id !== "string" || !value.default_footprint_id.trim()) {
    throw new Error(`${label}.default_footprint_id must be a non-empty string`)
  }
  if (
    !Array.isArray(value.footprint_files) ||
    value.footprint_files.length === 0 ||
    value.footprint_files.length > MAX_FOOTPRINT_VARIANTS
  ) {
    throw new Error(`${label}.footprint_files must contain 1-${MAX_FOOTPRINT_VARIANTS} entries`)
  }
  const footprint_files = value.footprint_files.map((file, index) => {
    if (typeof file !== "string" || !FOOTPRINT_FILE_PATTERN.test(file)) {
      throw new Error(
        `${label}.footprint_files[${index}] must match component-footprints/<footprint-id>.json`,
      )
    }
    return file
  })
  if (new Set(footprint_files).size !== footprint_files.length) {
    throw new Error(`${label}.footprint_files must not contain duplicates`)
  }
  return {
    version: 1,
    default_footprint_id: value.default_footprint_id,
    footprint_files,
  }
}

export async function readExtractedFootprintCatalog(workspace: string): Promise<{
  component_footprint_catalog: ComponentFootprintCatalog
  canonicalization_count: number
}> {
  const index = parseIndex(
    await readBoundedJsonArtifact({
      path: join(workspace, "component-footprint-catalog.json"),
      max_bytes: 256 * 1024,
      max_depth: 12,
      max_nodes: 2_000,
    }),
  )
  const variants_dir = join(workspace, "component-footprints")
  const variants_metadata = await lstat(variants_dir)
  if (variants_metadata.isSymbolicLink() || !variants_metadata.isDirectory()) {
    throw new Error("component-footprints must be a regular directory")
  }
  const directory_entries = await readdir(variants_dir, { withFileTypes: true })
  const expected_names = index.footprint_files.map((file) => basename(file)).sort()
  const actual_names = directory_entries.map(({ name }) => name).sort()
  if (
    directory_entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    JSON.stringify(actual_names) !== JSON.stringify(expected_names)
  ) {
    throw new Error("component-footprints must contain exactly the regular JSON files listed by the index")
  }

  let canonicalization_count = 0
  const footprints = []
  for (const relative_path of index.footprint_files) {
    const raw_variant = await readBoundedJsonArtifact({
      path: join(workspace, relative_path),
      max_bytes: 4 * 1024 * 1024,
      max_depth: 56,
      max_nodes: 120_000,
    })
    if (!isRecord(raw_variant)) {
      throw new Error(`${relative_path} must contain a footprint variant object`)
    }
    assertOnlyKeys(
      raw_variant,
      ["footprint_id", "label", "aliases", "ordering_codes", "component_evidence"],
      relative_path,
    )
    const expected_id = relative_path.match(FOOTPRINT_FILE_PATTERN)?.[1]
    if (raw_variant.footprint_id !== expected_id) {
      throw new Error(`${relative_path}.footprint_id must match its filename (${expected_id})`)
    }
    if (!isRecord(raw_variant.component_evidence)) {
      throw new Error(`${relative_path}.component_evidence must be an object`)
    }
    const canonicalization = canonicalizeComponentEvidenceInput(raw_variant.component_evidence)
    canonicalization_count += canonicalization.changes.length
    footprints.push({
      ...raw_variant,
      component_evidence: canonicalization.value,
    })
  }

  return {
    component_footprint_catalog: parseComponentFootprintCatalog({
      version: 1,
      default_footprint_id: index.default_footprint_id,
      footprints,
    }),
    canonicalization_count,
  }
}
