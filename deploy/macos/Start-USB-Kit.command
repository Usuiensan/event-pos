#!/bin/bash
set -eu

kit="$(cd -- "$(dirname -- "$0")" && pwd -P)"
cd "$kit"
exec "$kit/runtime/node" "$kit/server/dist/start.mjs"
