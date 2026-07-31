# Datasheet to tscircuit

Datasheet to tscircuit is a local Bun + React application that turns a PDF
datasheet into a validated tscircuit component and, optionally, a validated
behavioral SPICE model.

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

Install Bun 1.2.21 or newer, ngspice, and Poppler (`pdftotext`, `pdfinfo`, and
`pdftoppm`), then run:

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
- `component-validation.json` and `application-validation.json` contain the
  deterministic component validation outcomes.
- `spice/candidates/<revision>-<id>/validation/<case-id>` contains the exact
  ngspice netlist, process logs, raw output, and per-case result used for that
  immutable candidate.
- `published-model.json` is the version-2 atomic pointer binding the owning job
  and invocation, an accepted model revision, and its exact integrated
  component wrapper. It selects the
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
stage debug bundle.

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
working directories, but the agent process is not an OS security sandbox: it
still has outbound network access, configured credentials, and the container
user's filesystem permissions. A hosted deployment needs separate
authentication, quotas, durable storage, and stronger per-job sandboxing.
