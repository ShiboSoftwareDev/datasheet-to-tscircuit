#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /app/.runtime/jobs

  # Docker Desktop exposes host-owned, read-only bind-mounted files as root-owned
  # inside the VM, but rejects chown for those files. Pipeline snapshots are
  # intentionally mode 0400, so leave non-writable files alone and repair only
  # directories and files that the application may need to update.
  if ! find /app/.runtime -xdev \( -type d -o \( -type f -perm /u+w \) \) \
    -exec chown bun:bun {} +; then
    echo "warning: some writable runtime paths could not be assigned to bun" >&2
  fi

  if ! gosu bun test -w /app/.runtime/jobs; then
    echo "error: /app/.runtime/jobs is not writable by the bun user" >&2
    exit 1
  fi

  exec gosu bun "$@"
fi

exec "$@"
