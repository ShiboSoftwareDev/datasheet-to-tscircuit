# Datasheet to tscircuit

Datasheet to tscircuit is a local Bun + React application that turns a PDF
datasheet into a validated tscircuit component and, optionally, a validated
behavioral SPICE model.

Fresh SPICE generation starts only when the datasheet contains a reproducible
public-pin voltage waveform plotted against elapsed time. Static tables, DC
curves, operating points, and current-only plots remain visible as documented
specifications but are not presented as simulations.

The backend is organized as two explicit typed pipelines. AI agents work in
isolated temporary directories and propose narrowly scoped artifacts. The
server parses those artifacts, runs deterministic tscircuit and ngspice checks,
and promotes only validated canonical artifacts. The existing UI remains the
main place to watch logs, inspect the generated TSX and Circuit JSON, view
retained datasheet references, and compare reference curves with simulation
results.

See [Architecture](docs/architecture.md) for the stage graphs, artifact
contracts, debug layout, and extension rules.

## Run with Docker

Docker is the simplest way to run the complete application. It includes Bun,
ngspice, Poppler, `tsci-agent`, and `tsci`.

Prerequisites: Docker Desktop, Bun, and the `tsci` CLI on the host.

```bash
tsci login
cp .env.example .env
tsci auth print-token
```

Paste the printed token into `.env` as `TSCIRCUIT_JWT`, then start the app:

```bash
mkdir -p .runtime
bun start
```

Open <http://localhost:3000>. The container binds to host loopback and persists
all job artifacts under `.runtime/jobs`.

OpenAI is optional. To authenticate it for the agent provider:

```bash
bun run auth:openai
```

Credentials are stored under `.runtime/pi-agent`. Stop the app with:

```bash
bun run stop
```

## Develop locally

Install Bun 1.2.21 or newer, ngspice, Poppler (`pdftotext`, `pdfinfo`, and
`pdftoppm`), and Tesseract OCR (`tesseract`), then run:

```bash
bun install
tsci login
bun run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to the Bun API at
<http://localhost:3000>.

Useful overrides:

- `HOST` and `PORT` change the API bind address and port.
- `API_URL` changes the Vite proxy target.
- `TSCI_AGENT_BIN`, `TSCI_BIN`, and `NGSPICE_BIN` select local executables.

## Checks

```bash
bun run typecheck
bun test
bun run build:web
```

Run all three with `bun run check`. Docker startup behavior has a separate smoke
test:

```bash
bun run test:docker
```

## Debug a run

Start with the streamed logs in the UI; both component and model panels expose
their typed execution traces. The durable files under
`.runtime/jobs/<job-id>` are the source of truth after a restart:

- `agent.log`/`agent.log.1` and `job.json` contain the bounded component NDJSON
  logs and atomically replaced checkpoint.
- `spice/model-agent.log`/`spice/model-agent.log.1` and
  `spice/model-run.json` contain the bounded model NDJSON logs and atomically
  replaced checkpoint. Public stores keep only the latest 500 log events.
- `runs/<invocation-id>/.pipeline/events.ndjson` is the component event stream.
- `spice/runs/<invocation-id>/.pipeline/events.ndjson` is the model event stream.
- Each `.pipeline/stages/<number>-<stage-id>` directory contains `input.json`,
  `output.json`, `error.json`, `metrics.json`, and immutable copies of declared
  artifacts under `artifacts/`.
- Agent-backed stages also retain `attempt-history.json` plus every rejected
  candidate. Correction attempts receive those exact files and cumulative
  diagnostics, so fixing one field cannot silently regress an earlier fix. A
  typed or process failure inside a nested independent verifier also retains
  the enclosing outer candidate before the stage terminates.
- `component-validation.json` and `application-validation.json` contain the
  deterministic component validation outcomes.
- `footprint-geometry-review.json` and
  `footprint-geometry-verification.json` preserve a second agent's independent
  PCB-top pad transcription and the server-computed 0.01 mm agreement record.
  The reviewer receives the datasheet and trusted land-pattern render, but no
  extractor pin names or pad geometry.
- `application-connectivity-review.json` and
  `application-connectivity-verification.json` record an independently
  transcribed visible-component inventory and image-to-netlist graph plus their
  agreement hashes. Schema errors are accumulated; once the review is valid,
  inventory, visible-fact, and graph disagreements are reported together. Net
  names and ordering are ignored; component facts and endpoint connectivity
  must match. Independent observations are immutable and input-fingerprinted,
  so unchanged observations are reused across outer evidence repairs and
  atomically reinstalled over any retained workspace copy.
- Component identity keeps the visible base family separate from the selected
  orderable: for example, U1 `value` is `TPS63802` while its authoritative
  `manufacturer_part_number` is `TPS63802DLAR`. The server binds canonical U1
  from accepted evidence, requires an ordering code to extend its base family,
  and rejects a wrong, reversed, or truncated ordering identity.
- `evidence-image-manifest.json` binds server-rendered 200-DPI reference pages
  and UI aliases to the exact datasheet hash; agent-authored image pixels are
  never trusted.
- `evidence-commit.json` is the version-3 atomic pointer for the complete
  semantic evidence set. It selects one immutable
  `evidence-revisions/<generation-id>` directory containing the evidence and
  its exact source PDF. API readers return only those captured, hash-checked
  bytes, so a failed replacement, partial promotion, or later root-file
  mutation cannot expose a mixed generation. Legacy version-1 and version-2
  markers remain readable; model generation rejects version 1 because it did
  not bind a source PDF.
- `spice/candidates/<revision>-<id>/validation/<case-id>` contains the exact
  ngspice netlist, process logs, raw output, and per-case result used for that
  immutable candidate.
- `spice/attempts/<attempt-id>/time-graph-hints.json`,
  `model-reference-observation.json`, `model-reference-source-proof.json`, and
  `model-reference-verification.json` show which complete-PDF graph candidates
  were reviewed and how each accepted crop and numeric voltage/time trace were
  independently matched. A graph can become executable only when server code
  extracts its response, stimulus, levels, and edge times from printed numeric
  test conditions in the same PDF section; a missing or unsupported fixture is
  authoritative and cannot be filled in by an agent. The retained verification
  binds the exact observer crop, its adjacent figure caption, source-read axis
  units/scales, pixel-axis-calibrated observer points, observer/candidate curve
  digests, interpolation metrics, and the exact server-rendered graph pixels.
  Publication recomputes that PDF/OCR receipt instead of trusting retained
  metadata; the accepted bundle retains the hash-bound canonical
  `datasheet.pdf`, and the generation agent never receives the private observer
  trace.
- `spice/candidates/<revision>-<id>/validation/viewer-validation.json` and
  `validation/cases/<case-id>.circuit.json` bind the exact tscircuit transient
  voltage waveforms used by the TSX/Runframe UI to the generated model, pin
  map, pulsed source values, polarity, and source connectivity. The validation
  result also carries a hash-bound private replay receipt proving the response
  changes materially when the bound pulse is flattened.
- Accepted bundles contain `model-workflow-policy.json`. New runs are fixed to
  `fresh_time_voltage_v1`, so changing a candidate contract to scalar/DC data
  cannot downgrade publication into the legacy compatibility path.
- `published-model.json` is the version-3 atomic pointer binding the owning job,
  invocation, immutable fresh-waveform policy, accepted model revision, and
  exact integrated component wrapper. Version-2 pointers remain readable only
  for existing publications; the writer cannot create them. The pointer selects
  the
  hash-verified bundles under
  `spice/accepted-revisions/<revision>-<publication-id>` and
  `published-models/<revision>-<publication-id>`.

The selected bundles—not root-level compatibility mirrors such as
`spice/model.lib`—are authoritative for restart recovery, previews, downloads,
and the UI. Publication-backed readers return bounded bytes rechecked against
the captured manifest hash; they never hand a later consumer an unverified
filesystem path.

Pipeline failures include a stable error code, the failed stage, the operation,
related artifact or entity references, a cause chain, and a direct path to the
stage debug bundle. `provenance.json` records both the Git revision and a hash
of the actual workflow source files, so a dirty runtime remains reproducible.

## Source map

```text
src/
├── server/
│   ├── pipeline/             typed stage runner and diagnostics
│   ├── component-workflow/   datasheet-to-component pipeline
│   ├── model-workflow/       component-to-SPICE pipeline
│   ├── modeling/             model contracts, strategies, and UI projections
│   ├── spice-validation/     declarative fixture compiler and ngspice scoring
│   ├── infrastructure/       agent, process, artifact, and tscircuit adapters
│   ├── job-api/              component HTTP/SSE operations
│   └── model-run-api/        model HTTP/SSE operations
├── shared/                   browser/server contracts
└── web/                      React UI and tscircuit viewers
```

## Security scope

This is a trusted local application, not a public upload service. The Docker
container runs as a non-root user, drops Linux capabilities, publishes only on
host loopback, and mounts only `.runtime`. Agent attempts receive isolated
working directories. Model generation and repair additionally run without a
shell or built-in filesystem tools: a fail-closed extension can read only the
candidate workspace and can write only `model.lib` and `model-card.md`, keeping
server validation fixtures and held-out curve samples outside that tool
boundary. The overall agent process is still not an OS or network sandbox: it
has outbound provider access, configured credentials, and the container user's
process permissions. A hosted deployment needs separate authentication, quotas,
durable storage, and stronger per-job process/network sandboxing.
