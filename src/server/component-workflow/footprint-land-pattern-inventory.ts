import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { ComponentFootprintCatalog } from "../component-evidence"
import { readBoundedTextArtifact } from "../infrastructure/artifacts"
import type { ProcessRunner } from "../infrastructure/process"
import { writeJson } from "./stage-helpers"

const MAX_DISCOVERED_LAND_PATTERNS = 24

export interface FootprintLandPatternHint {
  page: number
  drawing_code: string
  package_code: string
  pin_count: number
}

function normalizedToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

/**
 * Finds manufacturer land-pattern pages without interpreting their geometry.
 * This is a completeness inventory for the agent, not an evidence extractor.
 */
export function parseFootprintLandPatternInventory(pdf_text: string): FootprintLandPatternHint[] {
  const hints: FootprintLandPatternHint[] = []
  for (const [page_index, page_text] of pdf_text.split("\f").entries()) {
    if (!/\b(?:LAND PATTERN EXAMPLE|RECOMMENDED LAND PATTERN)\b/i.test(page_text)) continue
    const drawing_match = page_text.match(/^\s*([A-Z]{1,8})(\d{4})[A-Z]?\b/m)
    if (!drawing_match) continue
    const package_code = drawing_match[1]!
    const pin_count = Number(drawing_match[2])
    if (!Number.isInteger(pin_count) || pin_count < 1 || pin_count > 512) continue
    if (hints.some((hint) => hint.package_code === package_code)) continue
    hints.push({
      page: page_index + 1,
      drawing_code: drawing_match[0].trim(),
      package_code,
      pin_count,
    })
    if (hints.length > MAX_DISCOVERED_LAND_PATTERNS) {
      throw new Error(
        `Datasheet contains more than ${MAX_DISCOVERED_LAND_PATTERNS} distinct coded land-pattern pages`,
      )
    }
  }
  return hints
}

function variantPackageTokens(catalog: ComponentFootprintCatalog): Array<{
  pin_count: number
  tokens: string[]
}> {
  return catalog.footprints.map((footprint) => ({
    pin_count: footprint.component_evidence.package.pin_count.value,
    tokens: [
      ...footprint.footprint_id.split("-"),
      footprint.component_evidence.package.name.value,
      ...(footprint.component_evidence.package.code ? [footprint.component_evidence.package.code.value] : []),
      ...footprint.aliases,
    ].flatMap((value) =>
      value
        .split(/[^A-Za-z0-9]+/)
        .map(normalizedToken)
        .filter(Boolean),
    ),
  }))
}

export function getMissingLandPatternHints(input: {
  catalog: ComponentFootprintCatalog
  hints: readonly FootprintLandPatternHint[]
}): FootprintLandPatternHint[] {
  const variants = variantPackageTokens(input.catalog)
  return input.hints.filter((hint) => {
    const package_token = normalizedToken(hint.package_code)
    return !variants.some(
      (variant) => variant.pin_count === hint.pin_count && variant.tokens.includes(package_token),
    )
  })
}

export async function discoverFootprintLandPatterns(input: {
  datasheet_path: string
  debug_dir: string
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<FootprintLandPatternHint[]> {
  await mkdir(input.debug_dir, { recursive: true })
  const text_path = join(input.debug_dir, "datasheet-layout.txt")
  await input.process_runner.run({
    command: ["pdftotext", "-layout", input.datasheet_path, text_path],
    command_label: "Inventory datasheet PCB land patterns",
    cwd: input.debug_dir,
    signal: input.signal,
    wall_timeout_ms: 120_000,
    max_output_chars: 20_000,
    on_output: input.on_output,
  })
  const pdf_text = await readBoundedTextArtifact({ path: text_path, max_bytes: 8 * 1024 * 1024 })
  const hints = parseFootprintLandPatternInventory(pdf_text)
  await writeJson(join(input.debug_dir, "footprint-land-pattern-inventory.json"), {
    version: 1,
    hints,
  })
  return hints
}
