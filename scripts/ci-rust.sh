#!/bin/sh
# CI (.forgejo/workflows/ci.yml): Rust for Quilcast WASM (wasm/). A Mac runner keeps rustup, the toolchain, the crates
# and the build's target directory in its tool cache; Linux installs rustup each time. Later steps get the same
# environment through GITHUB_ENV and GITHUB_PATH.
set -eu
if [ -n "${RUNNER_TOOL_CACHE:-}" ] && [ "${RUNNER_OS:-}" = macOS ]; then
  RUSTUP_HOME="$RUNNER_TOOL_CACHE/rustup"
  CARGO_HOME="$RUNNER_TOOL_CACHE/cargo"
  CARGO_TARGET_DIR="$RUNNER_TOOL_CACHE/quilcast-wasm-target"
  export RUSTUP_HOME CARGO_HOME CARGO_TARGET_DIR
  if [ -n "${GITHUB_ENV:-}" ]; then printf 'RUSTUP_HOME=%s\nCARGO_HOME=%s\nCARGO_TARGET_DIR=%s\n' "$RUSTUP_HOME" "$CARGO_HOME" "$CARGO_TARGET_DIR" >> "$GITHUB_ENV"; fi
fi
CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
export PATH="$CARGO_HOME/bin:$PATH"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$CARGO_HOME/bin" >> "$GITHUB_PATH"; fi
if ! command -v rustup > /dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain stable
fi
rustup toolchain install stable --profile minimal --target wasm32-unknown-unknown > /dev/null
# the toolchain's own cargo, ahead of any other on the PATH (a Mac runner has Homebrew's, without the wasm target)
bin=$(dirname "$(rustup which --toolchain stable cargo)")
export PATH="$bin:$PATH"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$bin" >> "$GITHUB_PATH"; fi
cargo --version
