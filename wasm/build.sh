#!/bin/sh
# Builds Quilcast WASM into wasm/dist: the module, the shell and the stylesheet under /assets/<build>/ (named by the
# hash of their bytes, so they can be cached for good) and index.html pointing at them. Needs Rust with the
# wasm32-unknown-unknown target; nothing else (no wasm-bindgen, no bundler).
set -eu
cd "$(dirname "$0")"
cargo build --release --locked --target wasm32-unknown-unknown
wasm=${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/quilcast_wasm.wasm
if command -v sha256sum > /dev/null; then sum="sha256sum"; else sum="shasum -a 256"; fi
build=$(cat "$wasm" web/shell.js web/app.css | $sum | cut -c1-16)
rm -rf dist
mkdir -p "dist/assets/$build"
cp "$wasm" "dist/assets/$build/app.wasm"
cp web/shell.js web/app.css "dist/assets/$build/"
cp ../public/favicon.svg dist/
sed "s/__BUILD__/$build/g" web/index.html > dist/index.html
echo "wasm/dist: build $build, $(wc -c < "dist/assets/$build/app.wasm" | tr -d ' ') bytes of wasm"
