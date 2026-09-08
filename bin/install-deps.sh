#!/bin/bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

# Herdr's server/build environment may not inherit a login-shell PATH.
refresh_path() {
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    if [[ -d "$dir" ]]; then
      PATH="$dir:$PATH"
    fi
  done
  export PATH
}
refresh_path

install_macos() {
  local brew_bin=""
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$candidate" ]]; then
      brew_bin="$candidate"
      break
    fi
  done
  if [[ -z "$brew_bin" ]] && command -v brew >/dev/null 2>&1; then
    brew_bin="$(command -v brew)"
  fi
  if [[ -z "$brew_bin" ]]; then
    echo "qrencode is required for terminal pairing QR codes, but Homebrew was not found." >&2
    echo "Install Homebrew, then reinstall the plugin." >&2
    return 1
  fi
  "$brew_bin" install qrencode
}

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  else
    echo "Installing qrencode requires root access. Install it with your system package manager, then reinstall the plugin." >&2
    return 1
  fi
}

install_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update
    run_root apt-get install -y qrencode
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y qrencode
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y qrencode
  elif command -v pacman >/dev/null 2>&1; then
    run_root pacman -Sy --noconfirm qrencode
  elif command -v apk >/dev/null 2>&1; then
    run_root apk add qrencode
  else
    echo "qrencode is required, but no supported package manager was found." >&2
    return 1
  fi
}

ensure_qrencode() {
  if command -v qrencode >/dev/null 2>&1; then
    echo "qrencode: $(command -v qrencode)"
    return 0
  fi
  case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *)
      echo "Automatic qrencode installation is not supported on this platform." >&2
      return 1
      ;;
  esac
  refresh_path
  if ! command -v qrencode >/dev/null 2>&1; then
    echo "qrencode installation completed but the executable is still unavailable." >&2
    return 1
  fi
  echo "qrencode installed: $(command -v qrencode)"
}

# macOS desktop panel: a floating window with one button per blocked option.
# Optional. Needs Xcode Command Line Tools for swiftc. Skipped elsewhere.
# The binary lives next to this script because Herdr's build step does not set
# HERDR_PLUGIN_STATE_DIR while events and actions do.
build_panel() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi
  local src="$ROOT/src/desktop/panel.swift"
  local out="$ROOT/bin/oncall-panel"
  if [[ -x "$out" && "$out" -nt "$src" ]]; then
    echo "panel: $out (up to date)"
    return 0
  fi
  if ! command -v swiftc >/dev/null 2>&1; then
    echo "swiftc not found; desktop panel disabled. Install Xcode Command Line Tools (xcode-select --install) and reinstall to enable it." >&2
    return 0
  fi
  echo "panel: compiling $src (this takes a while the first time)"
  if swiftc -O -o "$out" "$src"; then
    echo "panel: $out"
  else
    echo "panel: compile failed; desktop panel disabled, Telegram still works." >&2
    rm -f "$out"
  fi
}

ensure_qrencode
build_panel
