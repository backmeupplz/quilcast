#!/bin/sh
# CI (.forgejo/workflows/ci.yml): node_modules. A Mac runner keeps one install per lockfile (less its version, like the
# Dockerfile) and Node ABI in its tool cache, linked in rather than copied (it's 33k files); Linux installs
set -eu
if [ "$RUNNER_OS" != macOS ]; then exec npm ci --prefer-offline --no-audit --no-fund; fi
key=$(node -p 'const j = require("./package-lock.json"); delete j.version; delete j.packages[""].version; require("crypto").createHash("sha256").update(JSON.stringify(j)).digest("hex").slice(0, 16) + "-" + process.versions.modules')
c="$RUNNER_TOOL_CACHE/quilcast-modules"
if [ ! -d "$c/$key" ]; then
  npm ci --prefer-offline --no-audit --no-fund
  rm -rf "$c/$key.tmp" && mkdir -p "$c/$key.tmp" && mv node_modules "$c/$key.tmp/" && mv "$c/$key.tmp" "$c/$key"
fi
touch "$c/$key" && ln -s "$c/$key/node_modules" node_modules
# installs no run has used for a week go
find "$c" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} +
