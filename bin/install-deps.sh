#!/bin/bash
set -euo pipefail

# Herdr's server/build environment may not inherit a login-shell PATH.
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  if [[ -d "$dir" ]]; then
    PATH="$dir:$PATH"
  fi
done
export PATH

if command -v qrencode >/dev/null 2>&1; then
  echo "qrencode: $(command -v qrencode)"
  exit 0
fi

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

case "$(uname -s)" in
  Darwin) install_macos ;;
  Linux) install_linux ;;
  *)
    echo "Automatic qrencode installation is not supported on this platform." >&2
    exit 1
    ;;
esac

# Refresh common paths after package installation.
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  if [[ -d "$dir" ]]; then
    PATH="$dir:$PATH"
  fi
done
export PATH

if ! command -v qrencode >/dev/null 2>&1; then
  echo "qrencode installation completed but the executable is still unavailable." >&2
  exit 1
fi

echo "qrencode installed: $(command -v qrencode)"
