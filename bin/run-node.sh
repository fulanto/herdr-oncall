#!/bin/bash
# Herdr's server PATH is not a login shell. Find node, then cache the path.
set -euo pipefail

ROOT="${HERDR_PLUGIN_ROOT:-}"
if [[ -z "$ROOT" ]]; then
  ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"

STATE="${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-oncall}"
CACHE="$STATE/node-path"

have_node() {
  command -v node >/dev/null 2>&1
}

prepend_path() {
  if [[ -d "$1" ]]; then
    PATH="$1:$PATH"
  fi
}

cached_node() {
  if [[ -f "$CACHE" ]]; then
    local p
    p="$(<"$CACHE")"
    if [[ -n "$p" && -x "$p" ]]; then
      printf '%s\n' "$p"
      return 0
    fi
  fi
  return 1
}

save_cache() {
  mkdir -p "$STATE"
  printf '%s\n' "$1" > "$CACHE"
}

# Herdr's server may have a minimal PATH. Add common executable locations
# before using the cached Node path so child tools such as qrencode remain
# discoverable on every action invocation.
prepend_path /opt/homebrew/bin
prepend_path /usr/local/bin
prepend_path "$HOME/.local/bin"
prepend_path "$HOME/.volta/bin"
prepend_path "$HOME/.asdf/shims"
prepend_path "$HOME/.nodenv/shims"
prepend_path "$HOME/.local/share/mise/shims"
prepend_path "$HOME/.mise/shims"

if NODE="$(cached_node)"; then
  exec "$NODE" "$@"
fi

if ! have_node; then
  for dir in "$HOME/.nvm/versions/node/"*/bin "$HOME/.config/nvm/versions/node/"*/bin; do
    if [[ -x "$dir/node" ]]; then
      prepend_path "$dir"
    fi
  done
fi

if ! have_node; then
  for fnm in /opt/homebrew/bin/fnm /usr/local/bin/fnm "$HOME/.local/share/fnm/fnm" "$HOME/.fnm/fnm"; do
    if [[ -x "$fnm" ]]; then
      set +eu
      eval "$("$fnm" env --shell bash 2>/dev/null)" || true
      set -eu
      break
    fi
  done
fi

if ! have_node; then
  for mise in /opt/homebrew/bin/mise /usr/local/bin/mise "$HOME/.local/bin/mise"; do
    if [[ -x "$mise" ]]; then
      set +eu
      eval "$("$mise" activate bash 2>/dev/null)" || true
      set -eu
      break
    fi
  done
fi

if ! have_node; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    set -eu
  fi
fi

if have_node; then
  NODE="$(command -v node)"
else
  NODE="$(/bin/zsh -lic 'whence -p node' 2>/dev/null || true)"
  if [[ -z "$NODE" || ! -x "$NODE" ]]; then
    NODE="$(/bin/bash -lic 'command -v node' 2>/dev/null || true)"
  fi
fi

if [[ -z "${NODE:-}" || ! -x "$NODE" ]]; then
  echo "node not found for Herdr. Start Herdr from a terminal where 'command -v node' works, or put node on PATH." >&2
  exit 127
fi

save_cache "$NODE"
exec "$NODE" "$@"
