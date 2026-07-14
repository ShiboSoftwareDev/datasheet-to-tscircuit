#!/bin/sh
set -eu

docker compose run --rm --no-deps app sh -c '
  set -eu
  test "$(id -u)" -ne 0
  test -w /app/.runtime/jobs
  probe="/app/.runtime/jobs/.docker-smoke-test-$$"
  touch "$probe"
  test -f "$probe"
  rm "$probe"
  printf "Docker runtime writable as uid=%s gid=%s\n" "$(id -u)" "$(id -g)"
'
