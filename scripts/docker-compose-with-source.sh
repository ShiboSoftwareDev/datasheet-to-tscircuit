#!/bin/sh
set -eu

source_commit="$(git rev-parse HEAD 2>/dev/null || printf unavailable)"
if [ "$source_commit" != "unavailable" ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  source_commit="${source_commit}-dirty"
fi
export SOURCE_COMMIT="$source_commit"

exec docker compose "$@"
