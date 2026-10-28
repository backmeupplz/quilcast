#!/usr/bin/env python3
# Shared release script: keep .github/scripts/ identical in absplus, meshtastic-plus, todorant and quilcast. Repo values come from env.
"""Sends an uploaded iPhone build to App Review, released automatically once approved.
A submission of an app version still waiting or in review is cancelled, and its version takes the new number and build;
one holding only other items, such as custom product pages (todorant's appstore/cpp.py), is left to its review unless
such submissions take all of Apple's review slots.
  appstore.py <version> <build number> <notes file> [--dry-run]   (--dry-run prints the plan and changes nothing)
  env: APP_STORE_APP_ID, ASC_KEY_ID, ASC_ISSUER_ID; the key is AuthKey_<ASC_KEY_ID>.p8 in API_PRIVATE_KEYS_DIR
       (default ~/.appstoreconnect/private_keys), the folder altool reads too; optional SUBMIT_UNTIL, the Unix time
       after which it stops waiting for the build (before cancelling anything)"""
import base64, json, os, subprocess, sys, time, urllib.error, urllib.request
import notes
from urllib.parse import urlencode

APP, KEY_ID, ISSUER = os.environ["APP_STORE_APP_ID"], os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"]
KEY = os.path.join(os.path.expanduser(os.environ.get("API_PRIVATE_KEYS_DIR", "~/.appstoreconnect/private_keys")), f"AuthKey_{KEY_ID}.p8")
# States where a version can still take a new build and number
EDITABLE = {"PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"}
OPEN = ["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"]
REVIEWING = {"WAITING_FOR_REVIEW", "IN_REVIEW"}
SLOTS = 2  # "maximum limit of 2 in-flight reviewSubmissions for platform=IOS" (Apple's 409; undocumented)


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


def raw_signature(der):
    """openssl's DER ECDSA signature -> the r||s bytes ES256 wants"""
    i = 3 if der[1] & 0x80 else 2
    r = der[i + 2:i + 2 + der[i + 1]]
    j = i + 2 + der[i + 1]
    s = der[j + 2:j + 2 + der[j + 1]]
    return r.lstrip(b"\0").rjust(32, b"\0") + s.lstrip(b"\0").rjust(32, b"\0")


def token():
    now = int(time.time())
    unsigned = b64(json.dumps({"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}).encode()) + b"." + b64(
        json.dumps({"iss": ISSUER, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"}).encode())
    der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", KEY], input=unsigned, capture_output=True, check=True).stdout
    return (unsigned + b"." + b64(raw_signature(der))).decode()


def api(method, path, query=None, body=None, ok=()):
    url = "https://api.appstoreconnect.apple.com" + path + ("?" + urlencode(query) if query else "")
    request = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if e.code in ok:  # expected (e.g. the item is already in the submission), but it can also hide the real reason
            print(f"{method} {path}: {e.code}, carrying on: {body[:3000]}")
            return {}
        sys.exit(f"{method} {path}: {e.code} {body}")


def data(method, path, query=None, **kw):
    return api(method, path, query, **kw).get("data")


def resource(kind, id=None, attributes=None, **relationships):
    d = {"type": kind}
    if id: d["id"] = id
    if attributes: d["attributes"] = attributes
    if relationships: d["relationships"] = {k: {"data": v} for k, v in relationships.items()}
    return {"data": d}


def versions():
    return data("GET", f"/v1/apps/{APP}/appStoreVersions", {"filter[platform]": "IOS", "limit": 10})


def holds_version(submission):
    items = data("GET", f"/v1/reviewSubmissions/{submission['id']}/items", {"include": "appStoreVersion", "limit": 50}) or []
    return any((item.get("relationships", {}).get("appStoreVersion") or {}).get("data") for item in items)


def cancel_for_release(say, dry, why=""):
    """Before a release submits: cancels the open submissions holding an app version, which hands the version back for
    editing. One holding only custom product pages (todorant's appstore/cpp.py) or other items keeps its review, which
    cancelling would restart, unless such submissions fill Apple's in-flight slots: then the one Apple is least far
    along with makes room (appstore/cpp.py sends it again)."""
    replaced, others = [], []
    for submission in data("GET", "/v1/reviewSubmissions", {"filter[app]": APP, "filter[platform]": "IOS", "filter[state]": ",".join(OPEN)}):
        (replaced if holds_version(submission) else others).append(submission)
    # rejected first, then waiting (the last submitted first), then in review
    others.sort(key=lambda s: s["attributes"].get("submittedDate") or "", reverse=True)
    others.sort(key=lambda s: ["UNRESOLVED_ISSUES", "WAITING_FOR_REVIEW", "IN_REVIEW"].index(s["attributes"]["state"]))
    room = others[:max(0, len(others) - SLOTS + 1)]
    for submission in replaced:
        say(f"Cancel the {submission['attributes']['state']} submission {submission['id']}{why}")
    for submission in others:
        if submission in room:
            say(f"Cancel the {submission['attributes']['state']} submission {submission['id']}, which holds no app version, "
                f"to free one of Apple's {SLOTS} review slots")
        else:
            print(f"Leave the {submission['attributes']['state']} submission {submission['id']} alone: it holds no app version")
    if dry:
        return
    for submission in replaced + room:
        data("PATCH", f"/v1/reviewSubmissions/{submission['id']}", body=resource("reviewSubmissions", submission["id"], {"canceled": True}))
    for submission in room:  # its slot frees once the cancelling is done
        for attempt in range(40):
            if data("GET", f"/v1/reviewSubmissions/{submission['id']}")["attributes"]["state"] not in OPEN + ["CANCELING"]: break
            time.sleep(15)
        else:
            sys.exit(f"The cancelled submission {submission['id']} didn't finish cancelling within 10 minutes, so it still holds a review slot")


def main():
    version, build_number, notes_file = sys.argv[1:4]
    dry = "--dry-run" in sys.argv
    say = (lambda text: print("Would " + text[0].lower() + text[1:])) if dry else print

    # Processing takes a few minutes to half an hour after the upload
    query = {"filter[app]": APP, "filter[version]": build_number, "filter[preReleaseVersion.version]": version}
    for attempt in range(120):
        builds = data("GET", "/v1/builds", query)
        state = builds[0]["attributes"]["processingState"] if builds else "NOT_FOUND"
        if state == "VALID" or dry: break
        if state in ("FAILED", "INVALID"): sys.exit(f"Build {version} ({build_number}) is {state}")
        # SUBMIT_UNTIL (Unix time): give up while nothing is cancelled yet, rather than cancel and then hit the job's timeout
        if os.environ.get("SUBMIT_UNTIL") and time.time() > int(os.environ["SUBMIT_UNTIL"]):
            sys.exit(f"Out of time waiting for build {version} ({build_number}): nothing was cancelled")
        print(f"Build {version} ({build_number}): {state}, waiting")
        time.sleep(30)
    else:
        sys.exit("The build didn't finish processing within an hour")
    say(f"Use build {version} ({build_number}), now {state}")
    build = {"type": "builds", "id": builds[0]["id"]} if builds else None

    # A version's submission still waiting or in review is replaced by this one: cancelling hands its version back for editing
    cancel_for_release(say, dry)

    # Cancelling takes a moment to reach the version
    for attempt in range(40):
        all_versions = versions()
        current = next((v for v in all_versions if v["attributes"]["appStoreState"] in EDITABLE), None)
        if dry or current or not any(v["attributes"]["appStoreState"] in REVIEWING for v in all_versions): break
        time.sleep(15)
    if dry and not current:
        current = next((v for v in all_versions if v["attributes"]["appStoreState"] in REVIEWING), None)
    # The first version of an app can't have What's New
    first = all(current and v["id"] == current["id"] for v in all_versions)

    # App Store Connect has one editable version at a time: reuse it under the new number, or start one
    if current:
        old = current["attributes"]["versionString"]
        say((f"Rename version {old} to {version}" if old != version else f"Reuse version {version}")
            + f" ({current['attributes']['appStoreState']}) and attach build {build_number}")
        if not dry:
            attributes = {"releaseType": "AFTER_APPROVAL"}
            if current["attributes"]["versionString"] != version: attributes["versionString"] = version
            data("PATCH", f"/v1/appStoreVersions/{current['id']}", body=resource("appStoreVersions", current["id"], attributes, build=build))
    else:
        say(f"Create version {version} with build {build_number}")
        if not dry:
            current = data("POST", "/v1/appStoreVersions", body=resource(
                "appStoreVersions", attributes={"platform": "IOS", "versionString": version, "releaseType": "AFTER_APPROVAL"},
                app={"type": "apps", "id": APP}, build=build))

    # Each language gets its own notes (notes.py), or the English ones
    if first:
        print("First version of the app: no What's New")
    elif not current:
        print("Would set What's New in every language, the English being:\n" + notes.read(notes_file, "en-US", 4000))
    else:
        for localization in data("GET", f"/v1/appStoreVersions/{current['id']}/appStoreVersionLocalizations"):
            locale = localization["attributes"]["locale"]
            say(f"Set What's New in {locale} from {notes.path(notes_file, locale)}")
            if not dry:
                data("PATCH", f"/v1/appStoreVersionLocalizations/{localization['id']}",
                     body=resource("appStoreVersionLocalizations", localization["id"], {"whatsNew": notes.read(notes_file, locale, 4000)}))

    say(f"Submit {version} ({build_number}) for review, released automatically once approved")
    if dry:
        return
    # A draft submission (never sent) is reused; adding a version it already holds is a 409. A custom product page that
    # cpp.py left in it goes along, and the next release cancels it with the version (cpp.py sends it again)
    drafts = data("GET", "/v1/reviewSubmissions", {"filter[app]": APP, "filter[platform]": "IOS", "filter[state]": "READY_FOR_REVIEW"})
    submission = drafts[0] if drafts else data("POST", "/v1/reviewSubmissions", body=resource(
        "reviewSubmissions", attributes={"platform": "IOS"}, app={"type": "apps", "id": APP}))
    data("POST", "/v1/reviewSubmissionItems", body=resource(
        "reviewSubmissionItems", reviewSubmission={"type": "reviewSubmissions", "id": submission["id"]},
        appStoreVersion={"type": "appStoreVersions", "id": current["id"]}), ok=(409,))
    data("PATCH", f"/v1/reviewSubmissions/{submission['id']}", body=resource("reviewSubmissions", submission["id"], {"submitted": True}))
    print(f"{version} ({build_number}) is waiting for review")


if __name__ == "__main__":
    main()
