#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /app/.runtime/jobs
  chown -R bun:bun /app/.runtime
  exec gosu bun "$@"
fi

exec "$@"
