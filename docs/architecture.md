# Architecture

The backend has one generic pipeline engine and two domain workflows:

```text
PDF datasheet
    │
    ▼
datasheet_component pipeline ──► validated component TSX + Circuit JSON
                                            │
                                            ▼
                              datasheet_model pipeline
                                            │
                                            ▼
                         validated model + integrated component
                                            │
                                            ▼
                    existing React/runframe/reference-graph UI
```

The main architectural boundary is deliberate: an agent may propose an
artifact, but only server code may accept a contract, build a circuit, execute a
simulation, decide pass/fail, or publish a result.

## Layers

The new backend is split into small, directional layers:

- `src/shared/pipeline-types.ts` defines JSON-safe pipeline results, events,
  diagnostics, metrics, and artifact metadata shared with the browser.
- `src/server/pipeline` validates definitions and executes stages. It has no
  component, model, agent, tscircuit, or ngspice policy.
- `src/server/component-workflow` owns the component stage registry and
  component-specific orchestration.
- `src/server/model-workflow` owns the model stage registry and model-specific
  orchestration.
- `src/server/modeling` owns the versioned model interface and characterization
  contracts, strategy selection, canonical model artifacts, component
  integration, and UI projections.
- `src/server/spice-validation` parses declarative validation plans, compiles
  them to SPICE, executes ngspice, parses raw series, and scores results.
- `src/server/infrastructure` contains replaceable adapters for agents,
  processes, temporary artifact workspaces, and `tsci build`.
- Stores and API modules checkpoint public state and stream it to the existing
  React UI. They do not define workflow order.

`component-workflow/component-pipeline.ts` and
`model-workflow/model-pipeline.ts` are the only authoritative stage-order
registries. There is no dynamic stage discovery or phase dispatch by method
name.

## Typed stage protocol

A pipeline definition has a stable snake-case ID and an ordered list of typed
stage definitions. Every stage declares:

- a stable stage ID;
- its dependencies;
- a typed dependency-output object limited to those declared prior stages;
- a read-only run context and injected services;
- a JSON-serializable output;
- optional hashed artifacts, structured diagnostics, and scalar metrics.

The runner validates the graph before execution. It rejects duplicate or
missing IDs, forward dependencies, and dependency cycles. Completed outputs are
deep-frozen. A stage can complete or explicitly skip; an exception is converted
to a failed stage diagnostic. A stage whose dependency did not complete is
recorded as skipped, and cancellation records the active and remaining stages
as cancelled.

Stage results always have one of these states:

```text
pending → running → completed
                  ↘ skipped
                  ↘ failed
                  ↘ cancelled
```

The runner publishes an immutable snapshot after each event. `JobStore` and
`ModelRunStore` persist that snapshot, while the browser can display the same
stage IDs, states, durations, and diagnostics without parsing prose logs.

A stage marks `commit_state: "committed"` only after its irreversible
publication boundary. From that point onward, cancellation or a debug/event
write failure cannot reclassify the published result as failed. Post-commit
trace failures become structured warnings and are recorded best-effort in
`observer-errors.ndjson`; restart recovery resolves the durable publication.

### Diagnostics

`PipelineError` carries structured context instead of relying on string
matching:

- `code` and `severity` identify the failure class;
- `stage_id` and `operation` locate it in the workflow;
- entity and artifact references identify affected inputs or outputs;
- `cause_chain` retains nested error names, messages, and stacks;
- `hint` describes the next useful inspection;
- `retryable` distinguishes an actionable retry from a deterministic rejection.

Process failures have their own typed codes for spawn failure, non-zero exit,
idle timeout, absolute timeout, and cancellation. The process adapter streams
both output channels, keeps a bounded output tail, watches declared heartbeat
files, applies idle and wall-clock deadlines, and terminates the complete child
process group on cancellation.

## Debug artifacts

Every invocation gets a new UUID so retries never overwrite the preceding
trace:

```text
.runtime/jobs/<job-id>/runs/<invocation-id>/.pipeline/
├── events.ndjson
├── observer-errors.ndjson        # only when an optional snapshot sink fails
└── stages/
    ├── 01-prepare/
    │   ├── input.json
    │   ├── output.json
    │   ├── error.json
    │   └── metrics.json
    ├── 02-extract_evidence/
    │   ├── attempt-history.json
    │   └── rejected-attempts/<attempt>/...
    └── ...

.runtime/jobs/<job-id>/spice/runs/<invocation-id>/.pipeline/
├── events.ndjson
└── stages/...
```

`events.ndjson` is an append-only, sequenced timeline. A stage's `input.json`
records dependency states and completed dependency outputs. `output.json`
contains its terminal result, diagnostics, and SHA-256 artifact records;
`error.json` contains the structured failure when present; and `metrics.json`
contains timing, counts, and stage metrics.

Before a stage completes, the runner verifies each declared regular file and
copies it into a read-only `artifacts/` directory in that stage bundle. A later
retry therefore cannot change the bytes behind an earlier trace and hash.

The component and model logs remain at `agent.log` and
`spice/model-agent.log`. Each is NDJSON with one complete structured log event
per line, so arbitrary process chunks cannot merge or masquerade as another
event. Each current log and its single `.1` archive are capped at 2 MiB, one
event is capped at 256 KiB with an explicit truncation marker, and live stores
retain the latest 500 events. The pipeline trace is the authoritative
state-machine record.

## Component workflow

The component workflow is a single linear graph with an optional application
branch represented as data:

```text
prepare
  → extract_evidence
  → generate_component
  → validate_component
  → repair_component
  → generate_application
  → validate_application
  → repair_application
  → publish
```

| Stage | Responsibility |
| --- | --- |
| `prepare` | Record source/tool provenance, including the actual workflow-tree and evidence-contract hashes, and initialize public validation state. |
| `extract_evidence` | Let an isolated agent inspect the PDF, canonicalize only representation-equivalent input forms, strictly parse pinout/package/application evidence, render every cited page on the server, then independently transcribe both PCB-top pad geometry and the application graph from trusted page images. Pad geometry and net partitions must agree before the server derives plans and publishes the semantic evidence-set commit. |
| `generate_component` | Generate only `index.circuit.tsx` from accepted JSON plans and reference images. The PDF is not present in this workspace. |
| `validate_component` | Run `tsci build`; reject Circuit JSON errors; verify the footprint, pinout, schematic plan, and a server-created board fixture. |
| `repair_component` | Feed deterministic validation errors into bounded isolated repair attempts. Publish `component.circuit.tsx` as soon as the component passes. |
| `generate_application` | Generate a typical application only when the accepted application plan says one is documented. |
| `validate_application` | Check source shape, values, connectivity, and the resulting Circuit JSON against the accepted plan. |
| `repair_application` | Run bounded repairs. A still-invalid optional application becomes a warning rather than hiding a valid component. |
| `publish` | Commit the validated component, optional application, previews, and warnings. The runner marks the job terminal only after the pipeline trace is fully finalized. |

Important durable component artifacts include:

```text
datasheet.pdf
provenance.json
evidence-commit.json
evidence-revisions/<generation-id>/
├── datasheet.pdf
├── component-evidence.json
├── footprint-plan.json
├── component-schematic-plan.json
├── typical-application-plan.json
├── footprint-geometry-review.json
├── footprint-geometry-verification.json
├── application-connectivity-review.json
├── application-connectivity-verification.json
├── evidence-image-manifest.json
└── visual-reference/
index.circuit.tsx
component.circuit.tsx
component.circuit.json
component-validation.json
typical-application.circuit.tsx       # when documented and valid
application-validation.json
```

Agent output is not written directly into the canonical job directory. Each
artifact attempt receives a fresh temporary workspace containing only declared
inputs. The server parses and validates the candidate there, then promotes
declared files atomically. Invalid attempts are not promoted: their declared
files and validation error are retained under the stage's `rejected-attempts/`
debug directory. A correction workspace is safely seeded from those bounded,
no-symlink files and receives cumulative diagnostics plus the contract hash.
The expensive PDF extraction therefore survives a serialization correction. A
typed or process failure from a nested independent verifier still retains the
enclosing evidence candidate and adds it to the stage diagnostic before
terminating; cancellation remains cancellation and does not create a rejected
candidate.

The evidence contract is defined by shared version/enum constants and exact
canonical examples. Safe boundary canonicalization is deliberately narrow:
integer pin identifiers become strings, the industry synonym `smd` becomes
`smt`, and no other meaning-changing conversion is allowed. Missing versions,
prose or unsupported orientations, identities, dimensions, sources, and
connectivity are never invented. Agent-authored PNG pixels are discarded. The
server renders every cited PDF page at 200 DPI and binds each trusted image,
alias, source page, and the datasheet hash in `evidence-image-manifest.json`.

Identity has two explicit levels. `component-evidence.json` records the base
device family in `part_number` and the exact selected package/carrier variant
in `ordering_code` when they differ. The application-visible U1 `value` remains
the base family, while canonicalization binds U1 `manufacturer_part_number` to
the authoritative selected orderable for downstream generation. An ordering
code must be a distinct extension of its base identity after punctuation is
removed. A supplied wrong, reversed, or truncated identity is rejected. Legacy
exact-only evidence may infer a visible family only when the remaining suffix
matches a datasheet package identifier; arbitrary prefixes are not accepted.

For every application claim, including `not_present`, a second isolated agent
receives only the immutable source PDF and its reviewer contract—never the
extractor's page selection, crop, pin hints, component inventory, or graph. It
independently searches the document and emits visible components and electrical
endpoint partitions, or the sections it searched. The server compares the
component inventory and kind (plus any independently visible value or MPN),
canonicalizes physical U1 identities, external terminals, and unordered net
membership, ignores net names and ordering, and requires exact multiset graph
agreement. This catches omitted parts, kind/value disagreements, and misplaced
endpoints without trusting extractor-owned topology. Review parsing reports all
malformed endpoints without cascading derivative errors and, once the review is
valid, collects inventory, visible-fact, and graph differences into one
cumulative correction diagnostic instead of revealing one issue per outer
attempt.

Footprint geometry has the same independent boundary. A separate isolated
reviewer receives `datasheet.pdf`, the server-rendered full-page
`visual-reference/land-pattern.png`, but no extractor pin names,
`component-evidence.json`, `footprint-plan.json`, or extractor-authored
dimensions. The server strictly parses the review, rejects low-confidence or
duplicate-pad identities, and compares every pad center, copper dimension,
kind, and hole dimension at 0.01 mm tolerance. A valid disagreement rejects the
outer extraction candidate, so a plausible but copied special-pad dimension
cannot publish merely because generated TSX repeats it.

Independent reviews are observations, not mutable extractor artifacts. Each is
fingerprinted from its reviewer contract and immutable inputs: the bound source
PDF and, for footprint review, the trusted land-pattern page and content hash.
The fingerprint contains the effective schema, instructions, and base-prompt
digest rather than a manually synchronized version label. An unchanged
fingerprint reuses the same observation across outer evidence repairs; a changed
immutable input reruns the reviewer. Before comparison or publication, the
server atomically reinstalls its cached review JSON over the retained workspace
copy, preventing deletion, edits, or symlink substitution by a correction
attempt.

The version-3 evidence commit is the publication barrier. The server first
semantically re-parses the canonical evidence, derived plans, independent
footprint and application reviews, both agreement records, and trusted-image
manifest. It then materializes one fully synced immutable
`evidence-revisions/<generation-id>` directory and atomically replaces
`evidence-commit.json` to select it. API readers serve only the snapshotted
bytes covered by that pointer, so a failed replacement, partial promotion, or
later root-file mutation cannot expose a mixed evidence generation. Each
revision carries the exact datasheet bytes bound by the trusted-image manifest,
so model characterization cannot race a later PDF replacement. Version-1 and
version-2 markers remain read-compatible, but version 1 is not accepted as a
model-generation input because it did not bind the PDF.

Transport retries and artifact retries are separate. The agent adapter retries
only classified transient transport failures; schema, source, build, and
electrical failures go through their owning validation or repair stage.

## Model workflow

The model pipeline starts alongside the component job but waits for the
component pipeline's terminal publication:

```text
wait_for_component
  → prepare_workspace
  → characterize
  → design_validation
  → generate_model
  → validate_model
  → repair_model
  → publish_model
```

| Stage | Responsibility |
| --- | --- |
| `wait_for_component` | Wait for terminal component publication, not the early live-preview milestone, and fail with component context if the job cannot produce one. |
| `prepare_workspace` | Copy canonical inputs and derive an exact server-owned SPICE interface from accepted pin evidence. |
| `characterize` | Extract versioned behavioral requirements, assumptions, limitations, sources, and optional reference curves. Each requirement is explicitly `modeled` or `documented_only`. |
| `design_validation` | Accept a strictly parsed declarative fixture plan that covers every modeled requirement and every DUT pin. |
| `generate_model` | Generate a self-contained `model.lib` and explanatory `model-card.md`; derive the manifest and revision on the server. |
| `validate_model` | Compile fixtures, execute ngspice, compare numeric series, persist hashes/results, and update UI projections. |
| `repair_model` | Repair only the model from server-produced validation feedback. The validation plan remains unchanged; the effort multiplier bounds repair attempts. |
| `publish_model` | Generate the wrapper on the server, build it with `tsci`, verify its exact model and pin mapping, stage hash-verified immutable model/component bundles, and atomically select the pair with one publication pointer. |

### Stable model contracts

The handoffs between model stages are versioned files rather than prose or log
markers:

- `model-interface.json` is derived by the server from validated Circuit JSON.
  It owns the subcircuit entry name, physical pin order, the exact selector-safe
  port hints and source-port IDs present in that build, and SPICE node names.
- `model-characterization.json` is the parsed agent proposal.
- `model-contract.json` combines the interface fixed for the current invocation
  with accepted characterization requirements.
- `validation-plan.json` is a declarative circuit contract. An agent proposes
  fixture elements, analyses, and observations. Numeric references and
  datasheet evidence are server-owned output fields: the proposal parser
  replaces any legacy agent-authored copies with values derived from the
  immutable model contract before any model is generated. Persisted canonical
  plans use a separate strict parser so altered references or evidence fail
  restart and publication integrity checks.
- `model.lib` must expose exactly one public `.SUBCKT` with the server-owned
  entry and pin order. Self-contained private helper subcircuits and `.MODEL`
  definitions are allowed; external includes, control blocks, and shell commands
  are rejected.
- `model-manifest.json` is generated by the server and contains the canonical
  pin mapping plus a revision derived from the model source.
- `validation-results.json` records per-case series, metrics, errors, and hashes
  of the plan, model, and manifest used for the run.
- `published-model.json` version 2 binds the owning job, one invocation, model
  revision, accepted-model bundle manifest, and integrated-component bundle
  manifest. The pointer is the only publication commit point; files copied to
  legacy root paths afterward are compatibility mirrors.

The model-generation agent does not receive `validation-plan.json` or raw
validation artifacts. For each fresh modeled reference curve, the server keeps
the endpoints and alternating interior samples in a deterministic training view
and withholds the complementary interior samples. Fresh curves therefore need
at least five points. Generation and repair see only that training contract;
the immutable full contract remains authoritative for scoring and publication.
A regression model that matches every visible sample but misses a held-out
sample fails full server scoring.

Generation and repair also use a fail-closed agent capability profile. The only
enabled tool names come from one explicit extension: one reader confined to the
canonical temporary workspace and one writer confined to `model.lib` and
`model-card.md`. There is no shell, unrestricted built-in file tool, ambient
context-file discovery, or additional extension. The custom names do not match
built-ins, so an extension-load failure leaves the agent without tools instead
of silently restoring broad filesystem access. A repair receives the preceding
model plus an aggregate enum-and-count failure summary; simulator output, paths,
case IDs, observation IDs, metrics, sample counts, fixture values, hashes, and
validation coordinates never cross into its workspace. This keeps optimization
tied to documented behavior instead of a visible testbench.

The declarative validation language currently supports operating-point, DC
sweep, and transient analyses; resistor, capacitor, inductor, diode, voltage
source, and current source fixtures; voltage and current observations; and
target, bounds, or curve comparisons. It intentionally has no raw SPICE
expression or `.measure` escape hatch.

## SPICE execution and scoring

`spice-validation` implements one deterministic path:

1. Parse the complete plan and report all path-specific contract errors.
2. Verify the model entry/pin mapping, fixture identifiers, connectivity,
   ground, sweep source, requirement coverage, and DUT-pin coverage.
3. Compile each case to a server-owned SPICE netlist.
4. Remove stale raw data, request ASCII output, and run each case in its own
   artifact directory.
5. Parse ngspice raw vectors and compare every observation with its declared
   target, bounds, or reference curve.
6. Persist process logs, netlist/raw hashes, per-case results, and the aggregate
   result.

The replayable layout is:

```text
spice/candidates/<revision>-<id>/validation/
├── model.lib
├── validation-results.json
└── <case-id>/
    ├── .spiceinit
    ├── circuit.cir
    ├── result.raw
    ├── stdout.log
    ├── stderr.log
    └── result.json
```

This directory answers four debugging questions without rerunning an agent:
which inputs were tested, which netlist was executed, what the simulator
returned, and why the comparison passed or failed.

A passing candidate is still private until the integrated wrapper also builds
and its pin map matches. Publication creates a new immutable accepted pair:

```text
published-model.json
spice/accepted-revisions/<revision>-<publication-id>/
├── bundle-manifest.json
├── publication-record.json
├── model.lib
├── model-card.md
├── model-contract.json
├── validation-plan.json
├── validation-results.json
└── validation/cases/...
published-models/<revision>-<publication-id>/
├── bundle-manifest.json
├── publication-record.json
├── index.circuit.tsx
├── component.circuit.json
└── model.lib
```

Both manifests bind every regular file in their bundle, including identical
publication ownership records. Readers verify the complete file set, hashes,
owning job and invocation, model revision, deterministic wrapper, embedded
source, and exact pin map before selecting it. They then reopen individual
artifacts with `O_NOFOLLOW`, enforce per-file bounds, and recheck size and
SHA-256 before returning buffered bytes. A corrupt pointer or bundle is isolated
to that job during startup: the base component remains visible as failed with a
traceable integrity warning, and healthy siblings still restore. Prepared model
directories are removed on cancellation, stale identity, or any other
pre-pointer failure. Cleanup first resolves the current pointer and never
deletes the generation it selects.

Pointer and checkpoint writers treat rename as the visibility boundary. A
parent-directory `fsync` failure after rename is reported as a durability
warning rather than as a failed write, preventing callers from rolling back
live state after readers can already observe the new pointer.

## UI preservation

The rewrite keeps the existing browser contracts and visualization surfaces:

- component TSX and Circuit JSON viewers;
- datasheet land-pattern, schematic, and typical-application references;
- live logs, cancellation, retry, and persisted restoration;
- model source and model card views;
- validation-case selection and deterministic TSX fixture projections;
- retained datasheet graph images;
- reference-versus-result plots and comparison metrics;
- component and model execution traces with stage status, error code, and
  duration.

`modeling/ui-projection.ts` derives display data from the selected accepted
validation plan and server-scored result. It writes
`model-ui.json`, `validation/cases/<case-id>.preview.json`, and deterministic
`validation/cases/<case-id>.circuit.tsx`. A supported saved Circuit JSON snapshot
is used when one is available; otherwise the UI labels the deterministic TSX
projection as source-ready. The numeric comparison always comes from
`validation-results.json`.

The UI is a projection of canonical artifacts, not an independent validation
path. Changing tabs or selecting a case does not redefine the model contract or
pass/fail result.

## Extension points

### Add a pipeline stage

1. Add the stage output to the workflow's `*PipelineOutputs` type.
2. Implement the stage with `defineComponentStage` or `defineModelStage`.
3. Declare explicit dependencies and return JSON-safe output.
4. Add the stage once to the authoritative pipeline registry.
5. Return hashed artifacts and typed diagnostics where they help debugging.

Do not add a second orchestration list, infer progress from log text, or access a
store through an undeclared global.

### Add a model strategy

Add a versioned strategy to `modeling/strategy-registry.ts` (and its strategy ID
type when introducing a new ID). Declare supported model families and concise
guidance. Inject a custom `ModelStrategyRegistry` through `ModelRunnerContext`
for tests or alternate deployments.

### Add validation vocabulary

Extend the type, strict parser, connectivity/coverage validation, compiler, raw
series mapping, and scoring together. Preserve the declarative boundary: a new
feature must compile from typed data and must not accept arbitrary simulator
commands.

### Add an external adapter

Agents and child processes are interfaces injected through workflow services.
New providers should implement `AgentClient` or `ProcessRunner`, preserve typed
errors and cancellation, and avoid leaking provider-specific states into domain
stages.

## Design rules

1. One authoritative stage registry per workflow.
2. Stable, versioned, machine-validated contracts between stages.
3. Agents propose; server code validates, executes, scores, and publishes.
4. Within an invocation, accepted evidence and validation contracts are
   immutable once downstream generation begins. A retry starts a new invocation
   instead of rewriting the earlier trace.
5. Every agent attempt is isolated and only declared artifacts are promoted.
6. Validation failures are data until a bounded repair stage exhausts its
   budget.
7. Retry only the failure class that owns the retry policy.
8. Use structured diagnostics and artifact references, never log-marker state
   machines.
9. Derive UI projections from canonical artifacts instead of creating a second
   source of truth.
10. Keep agent, child-process, and tscircuit implementations behind injected
    services. Keep filesystem access explicit and confined to workflow and
    artifact modules.
11. Publish related artifacts as an immutable, fully hashed set selected by one
    atomic pointer; treat later root-file copies as compatibility only.
