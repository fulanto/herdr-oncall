#!/bin/sh
exec node "$(cd "$(dirname "$0")" && pwd)/install.mjs" "$@"
