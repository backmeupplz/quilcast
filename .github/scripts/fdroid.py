#!/usr/bin/env python3
# Shared release script: keep .github/scripts/ identical in absplus, meshtastic-plus and todorant. Repo values come from env.
"""Brings the app's open fdroiddata merge request up to a release: its metadata keeps one build entry, this version.
Once the merge request is merged, F-Droid's checkupdates follows new tags itself and this does nothing.
  fdroid.py <version> <version code> <commit> [--dry-run]   (--dry-run prints the change and pushes nothing)
  env: FDROID_MR (merge request number in fdroid/fdroiddata), FDROID_APP_ID, FDROID_FORK (e.g. backmeupplz/fdroiddata),
       FDROID_BRANCH, GITLAB_TOKEN (write_repository on the fork; only needed to push),
       optional FDROID_UPDATE_CHECK_MODE and FDROID_BINARIES to change those fields too (e.g. a new tag scheme),
       optional FDROID_GRADLE: the build entry's gradle value, the product flavor F-Droid builds (e.g. fdroid)"""
import difflib, json, os, re, subprocess, sys, tempfile, urllib.request
from urllib.parse import quote

API = "https://gitlab.com/api/v4/projects/"


def replace(metadata, pattern, new, field):
    metadata, found = re.subn(pattern, new, metadata)
    if found != 1:
        sys.exit(f"Expected one {field} line in the metadata, found {found}")
    return metadata


def rewrite(metadata, version, code, commit, update_check_mode=None, binaries=None, gradle=None):
    """The metadata at this release, formatted the way fdroiddata's rewritemeta check wants it.
    Exits if it doesn't hold exactly one build entry."""
    if len(re.findall(r"(?m)^  - versionName:", metadata)) != 1:
        sys.exit("The merge request's metadata should hold exactly one build entry")
    # YAML reads 1.2 as a number, so such versions get quotes like rewritemeta gives them
    name = f"'{version}'" if re.fullmatch(r"\d+(\.\d+)?", version) else version
    for key, value in (("versionName", name), ("versionCode", code), ("commit", commit), ("CurrentVersion", name), ("CurrentVersionCode", code)):
        metadata = replace(metadata, rf"(?m)^([ -]*{key}): .*$", lambda m, value=value: f"{m[1]}: {value}", key)
    if update_check_mode:
        metadata = replace(metadata, r"(?m)^UpdateCheckMode: .*$", lambda m: f"UpdateCheckMode: {update_check_mode}", "UpdateCheckMode")
    if binaries:
        # rewritemeta (ruamel.yaml, width 80) puts a value longer than 80 characters on a line of its own
        metadata = replace(metadata, r"(?m)^Binaries:.*(?:\n  \S.*)?$",
                           lambda m: "Binaries: " + ("\n  " if len(binaries) > 80 else "") + binaries, "Binaries")
    if gradle:
        # A flavored app needs its flavor here: with "yes" Gradle builds every flavor and fdroidserver finds no APK
        metadata = replace(metadata, r"(?m)^( +)gradle:\n(?:\1  - .*\n)+", lambda m: f"{m[1]}gradle:\n{m[1]}  - {gradle}\n", "gradle")
    return metadata


def git_failure(command, status, output, token):
    """git's output on one line, so a caller that shows only the last line of stderr (plainwallet's submit.py) still says why,
    with the token masked in case git echoes it."""
    output = " | ".join(line.strip() for line in output.splitlines() if line.strip()).replace(token, "***")
    return f"git {command} failed with status {status}: {output or 'no output'}"


def main():
    version, code, commit = sys.argv[1:4]
    dry = "--dry-run" in sys.argv
    fork, branch, path = os.environ["FDROID_FORK"], os.environ["FDROID_BRANCH"], f"metadata/{os.environ['FDROID_APP_ID']}.yml"
    mr = json.load(urllib.request.urlopen(API + "fdroid%2Ffdroiddata/merge_requests/" + os.environ["FDROID_MR"]))
    if mr["state"] != "opened":
        return print(f"F-Droid merge request !{mr['iid']} is {mr['state']}: F-Droid picks up new tags itself")
    old = urllib.request.urlopen(f"{API}{quote(fork, safe='')}/repository/files/{quote(path, safe='')}/raw?ref={quote(branch)}").read().decode()
    new = rewrite(old, version, code, commit, os.environ.get("FDROID_UPDATE_CHECK_MODE"), os.environ.get("FDROID_BINARIES"),
                  os.environ.get("FDROID_GRADLE"))
    if new == old:
        return print(f"F-Droid merge request !{mr['iid']} is at {version} already")
    print("".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), path, path)))
    if dry:
        return print("Dry run: nothing pushed")
    if not os.environ.get("GITLAB_TOKEN"):
        return print(f"::warning::No GITLAB_TOKEN secret: update F-Droid merge request !{mr['iid']} by hand")
    app = re.search(r"(?m)^AutoName: (.*)$", new).group(1)
    # The token reaches git through a credential helper, so it's never in a URL, an argument or the log
    helper = '!f() { echo username=oauth2; echo "password=$GITLAB_TOKEN"; }; f'
    with tempfile.TemporaryDirectory() as clone:
        def git(*args):
            p = subprocess.run(["git", "-c", "credential.helper=", "-c", "credential.helper=" + helper, "-c", "user.name=backmeupplz",
                                "-c", "user.email=backmeupplz@users.noreply.gitlab.com", *args], cwd=clone,
                               env=dict(os.environ, GIT_TERMINAL_PROMPT="0"), capture_output=True, text=True)
            if p.returncode:
                sys.exit(git_failure(args[0], p.returncode, p.stdout + p.stderr, os.environ["GITLAB_TOKEN"]))
        git("clone", "-q", "--depth", "1", "--single-branch", "--branch", branch, "--filter=blob:none", "--sparse",
            f"https://gitlab.com/{fork}.git", ".")
        git("sparse-checkout", "set", "--no-cone", "/" + path)
        with open(os.path.join(clone, path), "w") as f:
            f.write(new)
        git("commit", "-q", "-am", f"{app} {version}")
        git("push", "-q", "origin", "HEAD:" + branch)
    print(f"F-Droid merge request !{mr['iid']} is at {version} now: {mr['web_url']}")


if __name__ == "__main__":
    main()
