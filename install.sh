#!/bin/bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
"$ROOT/bin/install-deps.sh"
exec /bin/bash "$ROOT/bin/run-node.sh" "$ROOT/src/actions/install.mjs" "$@"
