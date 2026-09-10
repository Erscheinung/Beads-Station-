#!/usr/bin/env bash

set -Eeuo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$BASH_SOURCE")" && pwd)"
cd "$REPO_ROOT"

info() {
  printf '\n[setup] %s\n' "$*"
}

warn() {
  printf '[setup] warning: %s\n' "$*" >&2
}

die() {
  printf '[setup] error: %s\n' "$*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "Beads Station is a macOS/Tauri application; setup.sh must run on macOS."
fi

if ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools are required. Opening the macOS installer…"
  xcode-select --install >/dev/null 2>&1 || true
  die "Install Xcode Command Line Tools, then run ./setup.sh again."
fi

# Homebrew is only needed when Node or rustup is missing. Existing official
# Node/Rust installations continue to work without Homebrew.
need_brew=false
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  need_brew=true
fi
if ! command -v rustup >/dev/null 2>&1; then
  need_brew=true
fi

if [[ "$need_brew" == true ]]; then
  command -v brew >/dev/null 2>&1 || die "Node/npm or rustup is missing. Install Homebrew (https://brew.sh) or install Node.js and rustup manually, then run ./setup.sh again."
  BREW_PREFIX="$(brew --prefix)"
  export PATH="$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$PATH"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  info "Installing Node.js and npm with Homebrew"
  brew install node
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  die "Node.js and npm are required but could not be found after installation."
fi

# Vite 7 requires Node 20.19+ or 22.12+. Keep the failure message close to
# the cause instead of allowing npm or the Tauri CLI to fail later.
node --eval '
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major > 22 || (major === 22 && minor >= 12) ||
    (major === 20 && minor >= 19);
  if (!supported) process.exit(1);
' || die "Node $(node --version) is too old. Install Node 20.19+, 22.12+, or a newer supported release."

if ! command -v rustup >/dev/null 2>&1; then
  info "Installing rustup"
  brew install rustup-init
  rustup-init -y --no-modify-path --default-toolchain none
fi

if [[ -f "$HOME/.cargo/env" ]]; then
  # rustup-init intentionally does not modify this shell's PATH.
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

command -v rustup >/dev/null 2>&1 || die "rustup is required but could not be found."

RUST_TOOLCHAIN="$(awk -F '"' '$1 ~ /^[[:space:]]*channel[[:space:]]*=/ { print $2; exit }' rust-toolchain.toml)"
[[ -n "$RUST_TOOLCHAIN" ]] || die "Could not read the Rust channel from rust-toolchain.toml."

info "Installing/checking Rust toolchain $RUST_TOOLCHAIN"
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component rustfmt --component clippy

info "Installing JavaScript dependencies"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

# These tools are used by the running app, but their distribution is
# environment-specific and they are not dependencies of this repository.
# Keep the development server usable while making missing runtime tools clear.
missing_runtime_tools=""
for tool in bd claude; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing_runtime_tools="$missing_runtime_tools $tool"
  fi
done
if [[ -n "$missing_runtime_tools" ]]; then
  warn "Missing runtime CLI(s):$missing_runtime_tools. Install them separately for issue tracking/Claude features."
fi

if [[ ! -f .env ]]; then
  warn ".env is missing. Copy .env.example to .env and configure the Claude credentials before using Claude features."
fi

info "Starting Beads Station (npm run tauri dev)"
exec npm run tauri dev
