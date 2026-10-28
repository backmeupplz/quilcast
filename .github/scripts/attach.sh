#!/bin/bash
# Shared release script: keep .github/scripts/ identical in absplus, meshtastic-plus, todorant and quilcast. Repo values come from env.
# Attaches files to the release <tag> on git.borodutch.com and to the same release on the GitHub mirror, replacing files
# of the same name. Releases don't mirror, and download links (the site, F-Droid's Binaries) point at GitHub, so the GitHub
# release is created from the tag (mirrored within seconds) when it's missing, under the same title and notes.
#   attach.sh <tag> <file>...
#   env: GITHUB_SERVER_URL, GITHUB_REPOSITORY (set by Actions), FORGEJO_TOKEN (the job's token), GH_TOKEN (GitHub token
#        with repo scope), RELEASE_TITLE, RELEASE_NOTES, RELEASE_PRERELEASE=true (optional, for creating the GitHub release)
set -euo pipefail
tag=$1
shift
api=$GITHUB_SERVER_URL/api/v1/repos/$GITHUB_REPOSITORY/releases
auth="Authorization: token $FORGEJO_TOKEN"
release=$(curl -fsS -H "$auth" "$api/tags/$tag" | jq -e .id) || { echo "::error::No release $tag on $GITHUB_SERVER_URL"; exit 1; }
for file in "$@"; do
  name=$(basename "$file")
  for old in $(curl -fsS -H "$auth" "$api/$release/assets" | jq --arg name "$name" '.[] | select(.name == $name) | .id'); do
    curl -fsS -X DELETE -H "$auth" "$api/$release/assets/$old"
  done
  curl -fsS -H "$auth" -F "attachment=@$file" "$api/$release/assets?name=$name" > /dev/null
done

export GH_HOST=github.com
tries=0
until gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" --silent 2> /dev/null; do
  ((++tries < 30)) || { echo "::error::$tag hasn't reached the GitHub mirror"; exit 1; }
  sleep 10
done
gh release view "$tag" --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1 ||
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "${RELEASE_TITLE:-$tag}" --notes "${RELEASE_NOTES:-}" \
    $([ "${RELEASE_PRERELEASE:-}" = true ] && echo --prerelease)
gh release upload "$tag" "$@" --repo "$GITHUB_REPOSITORY" --clobber
