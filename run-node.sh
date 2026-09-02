#!/bin/bash
# Herdr does not spawn a login shell, so nvm/fnm/volta node is often missing.
set -euo pipefail

ROOT="${HERDR_PLUGIN_ROOT:-}"
if [[ -z "$ROOT" ]]; then
  ROOT="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
fi
cd "$ROOT"

have_node() {
  command -v node >/dev/null 2>&1
}

if ! have_node && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # nvm.sh expects bash
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

if ! have_node && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
fi

if ! have_node && [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
  eval "$("$HOME/.local/share/fnm/fnm" env)"
fi

if ! have_node && [[ -d "$HOME/.volta/bin" ]]; then
  PATH="$HOME/.volta/bin:$PATH"
fi

if ! have_node && [[ -s "$HOME/.asdf/asdf.sh" ]]; then
  # shellcheck disable=SC1091
  . "$HOME/.asdf/asdf.sh"
fi

for bindir in /opt/homebrew/bin /usr/local/bin; do
  if ! have_node && [[ -x "$bindir/node" ]]; then
    PATH="$bindir:$PATH"
    break
  fi
done

if ! have_node; then
  echo "node not found in Herdr PATH. Install Node 18+ or start Herdr from a terminal where 'node -v' works." >&2
  exit 127
fi

exec node "$@"
