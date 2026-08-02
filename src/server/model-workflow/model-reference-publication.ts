import { createHash } from "node:crypto"
import { lstat, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  createStageWorkspace,
  readBoundedJsonArtifact,
  validatePngArtifact,
  validateStageDirectory,
} from "../infrastructure/artifacts"
import { BunProcessRunner, type ProcessRunner } from "../infrastructure/process"
import type { ModelContract } from "../modeling/types"
import { stableStringify } from "../spice-validation"
import {
  parseCanonicalReferenceGraphObservation,
  verifyCharacterizationGraphEvidence,
  verifyReferenceGraphTracePixels,
  type ModelReferenceVerification,
} from "./reference-graph-observation"
import {
  applyReferenceGraphSourceEligibility,
  buildReferenceGraphSourceProof,
  parseReferenceGraphSourceProof,
} from "./reference-graph-axis-proof"
import { parseTimeGraphDiscovery } from "./time-graph-hints"
import { decodeModelEvidencePng } from "./model-evidence-pages"

export const MODEL_REFERENCE_TRACE_FILES = [
  "time-graph-hints.json",
  "model-reference-observation.json",
  "model-reference-source-proof.json",
  "model-reference-verification.json",
] as const

const MAX_CANONICAL_DATASHEET_BYTES = 30 * 1024 * 1024
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024
const MAX_OBSERVATION_BYTES = 4 * 1024 * 1024
const MAX_SOURCE_PROOF_BYTES = 8 * 1024 * 1024
const MAX_VERIFICATION_BYTES = 4 * 1024 * 1024

/**
 * Only clearly scalar-only modeled contracts are treated as legacy. Any
 * transient or elapsed-time/cropped modeled input takes the fail-closed path;
 * deleting one fresh field therefore cannot turn publication proof off.
 */
export function modelContractRequiresReferencePublicationProof(contract: ModelContract): boolean {
  const modeled = contract.characterization.requirements.filter(({ support }) => support.status === "modeled")
  return modeled.some(
    (requirement) =>
      requirement.analysis === "transient" ||
      requirement.reference_curve?.x_quantity === "time" ||
      requirement.reference_curve?.x_unit === "s" ||
      requirement.reference_curve?.crop !== undefined,
  )
}

async function hashCanonicalDatasheet(datasheet_path: string): Promise<string> {
  const metadata = await lstat(datasheet_path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Fresh waveform publication requires a regular canonical datasheet.pdf")
  }
  if (metadata.size < 1 || metadata.size > MAX_CANONICAL_DATASHEET_BYTES) {
    throw new Error(
      `Fresh waveform publication requires canonical datasheet.pdf to be 1 through ${MAX_CANONICAL_DATASHEET_BYTES} bytes`,
    )
  }
  return createHash("sha256")
    .update(await readFile(datasheet_path))
    .digest("hex")
}

async function assertSameRenderedPixels(input: {
  retained_path: string
  canonical_path: string
  requirement_id: string
}): Promise<void> {
  const [retained, canonical] = await Promise.all([
    decodeModelEvidencePng(input.retained_path, input.requirement_id),
    decodeModelEvidencePng(input.canonical_path, input.requirement_id),
  ])
  if (retained.width !== canonical.width || retained.height !== canonical.height) {
    throw new Error(
      `Retained reference crop ${input.requirement_id} does not match the canonical PDF render dimensions`,
    )
  }
  for (let y = 0; y < retained.height; y += 1) {
    for (let x = 0; x < retained.width; x += 1) {
      const retained_pixel = retained.rgbAt(x, y)
      const canonical_pixel = canonical.rgbAt(x, y)
      if (
        retained_pixel[0] !== canonical_pixel[0] ||
        retained_pixel[1] !== canonical_pixel[1] ||
        retained_pixel[2] !== canonical_pixel[2]
      ) {
        throw new Error(
          `Retained reference crop ${input.requirement_id} is not the exact server render of canonical datasheet.pdf`,
        )
      }
    }
  }
}

async function verifyCanonicalReferenceCropRenders(input: {
  contract: ModelContract
  datasheet_path: string
  evidence_dir: string
  process_runner: ProcessRunner
  signal?: AbortSignal
}): Promise<void> {
  const cropped_requirements = input.contract.characterization.requirements.flatMap((requirement) =>
    requirement.support.status === "modeled" && requirement.reference_curve?.crop
      ? [{ requirement_id: requirement.requirement_id, crop: requirement.reference_curve.crop }]
      : [],
  )
  if (cropped_requirements.length === 0) return
  const signal = input.signal ?? new AbortController().signal
  const workspace = await createStageWorkspace({
    prefix: "model-publication-reference-render",
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    const rendered_dir = join(workspace.path, "figures")
    await mkdir(rendered_dir, { recursive: true })
    for (const [index, { requirement_id, crop }] of cropped_requirements.entries()) {
      signal.throwIfAborted()
      const output_prefix = join(rendered_dir, `crop-${index}`)
      await input.process_runner.run({
        command: [
          "pdftoppm",
          "-f",
          String(crop.page),
          "-l",
          String(crop.page),
          "-r",
          String(crop.render_dpi),
          "-x",
          String(crop.x_px),
          "-y",
          String(crop.y_px),
          "-W",
          String(crop.width_px),
          "-H",
          String(crop.height_px),
          "-png",
          "-singlefile",
          join(workspace.path, "datasheet.pdf"),
          output_prefix,
        ],
        command_label: `Re-render canonical reference graph ${requirement_id} for publication`,
        cwd: workspace.path,
        signal,
        wall_timeout_ms: 120_000,
        max_output_chars: 20_000,
      })
      await assertSameRenderedPixels({
        retained_path: join(input.evidence_dir, "figures", `${requirement_id}.png`),
        canonical_path: `${output_prefix}.png`,
        requirement_id,
      })
    }
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}

/**
 * Rebuilds the complete independent source proof from bounded retained inputs.
 * The caller should point evidence_dir at the exact snapshot it will publish,
 * not at an agent workspace that can later diverge from the bundle.
 */
export async function revalidateModelReferencePublication(input: {
  contract: ModelContract
  datasheet_path: string
  evidence_dir: string
  process_runner?: ProcessRunner
  signal?: AbortSignal
}): Promise<{ required: boolean; verification?: ModelReferenceVerification }> {
  if (!modelContractRequiresReferencePublicationProof(input.contract)) return { required: false }
  input.signal?.throwIfAborted()
  const trace_dir = dirname(input.evidence_dir)
  const [source_pdf_sha256, discovery_value, observation_value, source_proof_value, stored_verification] =
    await Promise.all([
      hashCanonicalDatasheet(input.datasheet_path),
      readBoundedJsonArtifact({
        path: join(trace_dir, "time-graph-hints.json"),
        max_bytes: MAX_DISCOVERY_BYTES,
        max_depth: 16,
        max_nodes: 20_000,
      }),
      readBoundedJsonArtifact({
        path: join(trace_dir, "model-reference-observation.json"),
        max_bytes: MAX_OBSERVATION_BYTES,
        max_depth: 32,
        max_nodes: 100_000,
      }),
      readBoundedJsonArtifact({
        path: join(trace_dir, "model-reference-source-proof.json"),
        max_bytes: MAX_SOURCE_PROOF_BYTES,
        max_depth: 48,
        max_nodes: 200_000,
      }),
      readBoundedJsonArtifact({
        path: join(trace_dir, "model-reference-verification.json"),
        max_bytes: MAX_VERIFICATION_BYTES,
        max_depth: 32,
        max_nodes: 100_000,
      }),
    ])
  input.signal?.throwIfAborted()
  const discovery = parseTimeGraphDiscovery(discovery_value, source_pdf_sha256)
  const observation = parseCanonicalReferenceGraphObservation(
    observation_value,
    discovery,
    input.contract.interface,
    input.contract.application_fixture,
  )
  const stored_source_proof = parseReferenceGraphSourceProof(source_proof_value, source_pdf_sha256)
  const process_runner = input.process_runner ?? new BunProcessRunner()
  const recomputed_source_proof = await buildReferenceGraphSourceProof({
    observation,
    datasheet_path: input.datasheet_path,
    process_runner,
    signal: input.signal ?? new AbortController().signal,
  })
  if (stableStringify(stored_source_proof) !== stableStringify(recomputed_source_proof)) {
    throw new Error(
      "model-reference-source-proof.json is stale or tampered; it does not match canonical datasheet.pdf OCR axis calibration",
    )
  }
  const source_observation = applyReferenceGraphSourceEligibility({
    observation,
    proof: recomputed_source_proof,
  })
  const numeric_verification = verifyCharacterizationGraphEvidence({
    characterization: input.contract.characterization,
    observation: source_observation,
    source_proof: recomputed_source_proof,
  })
  await validateStageDirectory({
    root: input.evidence_dir,
    max_files: 64,
    max_total_bytes: 64 * 1024 * 1024,
    validate_file: validatePngArtifact,
  })
  await verifyCanonicalReferenceCropRenders({
    contract: input.contract,
    datasheet_path: input.datasheet_path,
    evidence_dir: input.evidence_dir,
    process_runner,
    signal: input.signal,
  })
  input.signal?.throwIfAborted()
  const recomputed_verification = await verifyReferenceGraphTracePixels({
    characterization: input.contract.characterization,
    observation: source_observation,
    numeric_verification,
    evidence_dir: input.evidence_dir,
  })
  input.signal?.throwIfAborted()
  if (stableStringify(stored_verification) !== stableStringify(recomputed_verification)) {
    throw new Error(
      "model-reference-verification.json is stale or tampered; it does not match the canonical PDF, independent observation, characterization, and retained graph pixels",
    )
  }
  return { required: true, verification: recomputed_verification }
}
