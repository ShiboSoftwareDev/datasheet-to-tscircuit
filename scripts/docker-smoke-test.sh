#!/bin/sh
set -eu

docker compose run --rm --no-deps app sh -c '
  set -eu
  test "$(id -u)" -ne 0
  test -f /app/bun.lock
  test -w /app/.runtime/jobs
  command -v ngspice >/dev/null
  command -v pdftoppm >/dev/null
  test -x /app/node_modules/.bin/tsci
  test -x /app/node_modules/.bin/tsci-agent

  runtime_probe="/app/.runtime/jobs/.docker-smoke-test-$$"
  touch "$runtime_probe"
  test -f "$runtime_probe"
  rm "$runtime_probe"

  probe_dir="/tmp/datasheet-to-tscircuit-smoke-$$"
  mkdir "$probe_dir"
  trap '\''rm -rf "$probe_dir"'\'' EXIT HUP INT TERM

  printf "%s\n" \
    "* production ngspice smoke" \
    "V1 in 0 DC 1" \
    "R1 in 0 1k" \
    ".op" \
    ".end" > "$probe_dir/runtime-smoke.cir"
  ngspice -b -r "$probe_dir/runtime-smoke.raw" "$probe_dir/runtime-smoke.cir" >/dev/null 2>&1
  test -s "$probe_dir/runtime-smoke.raw"

  printf "%s\n" \
    "export default function Smoke() {" \
    "  return (" \
    "    <board routingDisabled>" \
    "      <resistor name=\"R1\" resistance=\"1k\" />" \
    "    </board>" \
    "  )" \
    "}" > "$probe_dir/runtime-smoke.circuit.tsx"
  (
    cd "$probe_dir"
    NODE_ENV=development /app/node_modules/.bin/tsci build \
      runtime-smoke.circuit.tsx \
      --ignore-errors \
      --ignore-warnings \
      --disable-pcb >/dev/null
  )
  test -s "$probe_dir/dist/runtime-smoke/circuit.json"

  /app/node_modules/.bin/tsci-agent --version >/dev/null
  printf "Docker runtime, ngspice, and tsci smoke passed as uid=%s gid=%s\n" "$(id -u)" "$(id -g)"
'
