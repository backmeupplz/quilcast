#!/usr/bin/env python3
# Shared release script: keep .github/scripts/ identical in absplus, meshtastic-plus and todorant. Repo values come from env.
"""Sends an Android App Bundle to Google Play production (full rollout) for review.
A release still in review is withdrawn for this one (changesInReviewBehavior=CANCEL_IN_REVIEW_AND_SUBMIT).
  play.py <bundle.aab> <version name> <notes file> [--dry-run]   (--dry-run validates the edit, then discards it)
  env: PLAY_PACKAGE, PLAY_SERVICE_ACCOUNT_JSON (key of a service account with release rights on the app in Play Console)"""
import base64, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request
import notes

ROOT = "https://androidpublisher.googleapis.com/"


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


def access_token():
    account = json.loads(os.environ["PLAY_SERVICE_ACCOUNT_JSON"])
    now = int(time.time())
    unsigned = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()) + b"." + b64(json.dumps({
        "iss": account["client_email"], "scope": "https://www.googleapis.com/auth/androidpublisher",
        "aud": account["token_uri"], "iat": now, "exp": now + 3600}).encode())
    with tempfile.NamedTemporaryFile("w") as key:
        key.write(account["private_key"])
        key.flush()
        signature = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key.name], input=unsigned, capture_output=True, check=True).stdout
    form = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                   "assertion": (unsigned + b"." + b64(signature)).decode()}).encode()
    return json.load(urllib.request.urlopen(account["token_uri"], form))["access_token"]


def main():
    bundle, name, notes_file = sys.argv[1:4]
    dry = "--dry-run" in sys.argv
    token = access_token()
    edits = ROOT + f"androidpublisher/v3/applications/{os.environ['PLAY_PACKAGE']}/edits"

    def call(method, url, body=b"", content_type="application/json"):
        request = urllib.request.Request(url, body, method=method, headers={"Authorization": "Bearer " + token, "Content-Type": content_type})
        try:
            with urllib.request.urlopen(request) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {url.split('?')[0]}: {e.code} {e.read().decode()}")

    edit = call("POST", edits, b"{}")["id"]
    code = call("POST", edits.replace(ROOT, ROOT + "upload/") + f"/{edit}/bundles?uploadType=media",
                open(bundle, "rb").read(), "application/octet-stream")["versionCode"]
    # Notes in every language the listing has: its own (notes.py), or the English ones
    languages = [listing["language"] for listing in call("GET", f"{edits}/{edit}/listings").get("listings", [])] or ["en-US"]
    for language in languages:
        print(f"{language} release notes: {notes.path(notes_file, language)}")
    call("PUT", f"{edits}/{edit}/tracks/production", json.dumps({"track": "production", "releases": [{
        "name": name, "versionCodes": [str(code)], "status": "completed",
        "releaseNotes": [{"language": language, "text": notes.read(notes_file, language, 500)} for language in languages]}]}).encode())
    if dry:
        call("POST", f"{edits}/{edit}:validate")
        call("DELETE", f"{edits}/{edit}", None)
        print(f"Play accepts {name} ({code}) for production; nothing was sent (dry run)")
    else:
        call("POST", f"{edits}/{edit}:commit?changesInReviewBehavior=CANCEL_IN_REVIEW_AND_SUBMIT")
        print(f"{name} ({code}) is in review for Play production")


if __name__ == "__main__":
    main()
