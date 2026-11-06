#!/bin/sh
# CI, on each push to main it builds (.forgejo/workflows/ci.yml): publishes dist/build.json to this repo's `builds` branch, which
# the push mirror copies to GitHub, for scripts/verify.mjs to look up. Two files per commit, written once and never changed:
#   <build>.json    the build's file hashes, with the first commit built into it
#   commits/<sha>   the build that commit makes
# Env: SHA (the commit), URL (the repo to push to), TOKEN (optional, CI's token). Run it after `npm run build`.
set -eu
: "${SHA:?}" "${URL:?}"
dist=$(pwd)/dist
id=$(node -p 'require(process.argv[1]).build' "$dist/build.json")
w=$(mktemp -d)
trap 'rm -rf "$w"' EXIT
if [ -n "${TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
  GIT_CONFIG_VALUE_0="Authorization: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
  export GIT_CONFIG_VALUE_0
fi
g() { git -C "$w" -c user.name='Quilcast CI' -c user.email=ci@quilcast.com "$@"; }
# a push from a run for another commit can land in between: start again from the branch as it is then
for try in 1 2 3 4 5; do
  [ "$try" = 1 ] || sleep $((try * 3))
  rm -rf "$w" && mkdir "$w" && g init -q
  rc=0 && git ls-remote --exit-code "$URL" refs/heads/builds >/dev/null || rc=$?
  if [ "$rc" = 0 ]; then
    g fetch -q --depth=1 "$URL" builds && g checkout -q -B builds FETCH_HEAD || continue
  elif [ "$rc" = 2 ]; then
    # the first build: a branch of its own, with no history from main
    g symbolic-ref HEAD refs/heads/builds
    printf '%s\n' '# Quilcast builds' '' 'Written by CI on each push to main it builds (scripts/publish-build.sh): `<build>.json` holds the SHA-256 of every file of a build and of the inline scripts its pages may run, with the first commit built into it; `commits/<sha>` names the build a commit makes. `node scripts/verify.mjs` (on main) checks quilcast.com against them; README, "Verify this build".' > "$w/README.md"
  else
    continue
  fi
  mkdir -p "$w/commits"
  [ -e "$w/$id.json" ] || node -e 'const b = require(process.argv[1]); console.log(JSON.stringify({ ...b, commit: process.argv[2] }, null, 1))' "$dist/build.json" "$SHA" > "$w/$id.json"
  [ -e "$w/commits/$SHA" ] || echo "$id" > "$w/commits/$SHA"
  g add -A
  if g diff --cached --quiet; then echo "build $id of $SHA was already published"; exit 0; fi
  # [skip ci] also keeps Tugport from deploying it
  g commit -q -m "Build $id of $SHA [skip ci]"
  if g push -q "$URL" HEAD:refs/heads/builds; then echo "published build $id of $SHA"; exit 0; fi
done
echo "couldn't publish build $id of $SHA" >&2
exit 1
