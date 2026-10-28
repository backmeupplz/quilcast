#!/usr/bin/env python3
# Shared release script: keep .github/scripts/ identical in absplus, meshtastic-plus, todorant and quilcast. Repo values come from env.
"""Store listings in every language, from the texts and screenshots in the repo.
  listings.py play [--dry-run]                    Google Play: title, short and full description, feature graphic and
                                                  phone, 7" and 10" screenshots per language; committing sends them to review
  listings.py appstore [--version X.Y.Z] [--dry-run]
                                                  App Store: name and subtitle, description, keywords, promotional text and
                                                  6.9" iPhone and 13" iPad screenshots per locale, on the version being
                                                  prepared, so they ship with it; with no such version and none in review,
                                                  it starts version X.Y.Z
                                                  (default: the last one's patch + 1), which appstore.py then renames and submits;
                                                  --release <build number> (release.yml, right before appstore.py) first waits for
                                                  that build to process, then cancels a submission waiting or in review, as
                                                  appstore.py would, so the listing goes on that version;
                                                  --until <Unix time> stops it in time: before cancelling while the build
                                                  still processes, and before a screenshot set once 15 minutes are left
Play: fastlane/metadata/android/<Play language>/title.txt, short_description.txt, full_description.txt and
  images/featureGraphic.{png,jpg}, images/{phone,sevenInch,tenInch}Screenshots/*.{png,jpg}
App Store: appstore/<locale>/listing.md (en-US: appstore/listing.md), sections "## Name", "## Subtitle", "## Keywords",
  "## Promotional text" and "## Description" (a "(max N)" after the title is fine), and appstore/screenshots/<locale>/*.{png,jpg}
  (6.9" iPhone) and appstore/screenshots/<locale>/ipad-13/*.{png,jpg} (13" iPad); a set with no files is left as it is
--dry-run prints the changes and sends nothing (Play validates them in an edit it then discards). Only what differs
from the store is sent, so running it again is safe.
env: as for play.py and appstore.py."""
import glob, hashlib, http.client, json, os, re, sys, time, urllib.error, urllib.request

PLAY_ROOT, APPSTORE_ROOT, SHOTS_ROOT = "fastlane/metadata/android", "appstore", "appstore/screenshots"
PLAY_TEXTS = {"title": "title.txt", "shortDescription": "short_description.txt", "fullDescription": "full_description.txt"}
PLAY_IMAGES = {"featureGraphic": "featureGraphic", "phoneScreenshots": "phoneScreenshots/*",
               "sevenInchScreenshots": "sevenInchScreenshots/*", "tenInchScreenshots": "tenInchScreenshots/*"}
VERSION_TEXTS = {"description": "Description", "keywords": "Keywords", "promotionalText": "Promotional text"}
INFO_TEXTS = {"name": "Name", "subtitle": "Subtitle"}
# appstore/screenshots/<locale>/<folder> -> its screenshot set; Apple scales each down for the smaller devices
DISPLAYS = {"": ("APP_IPHONE_67", '6.9" iPhone'),  # 1320x2868
            "ipad-13": ("APP_IPAD_PRO_3GEN_129", '13" iPad')}  # 2064x2752
TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
SHOT_MINUTES = 15  # left before a locale's screenshot set goes: its upload, then 10 minutes or more for Apple to process it
PROCESS_MINUTES = 30  # without --until: how long the sets sent may take to process, all together, after the last one went
UNTIL = None  # --until: the Unix time by which a release needs this done, so App Review still gets its turn


def images(pattern):
    return sorted(f for f in glob.glob(pattern + ".*") if os.path.splitext(f)[1].lower() in TYPES)


def digest(path, kind="sha256"):
    return hashlib.new(kind, open(path, "rb").read()).hexdigest()


def sections(path):
    """The "## Title" sections of a listing.md, without their "(max N)" and surrounding blank lines"""
    out, name = {}, None
    for line in open(path, encoding="utf-8").read().split("\n"):
        m = re.match(r"^## (.+?)(?: \(max \d+\))?$", line)
        if m:
            name = m[1]
            out[name] = []
        elif name:
            out[name].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def appstore_locales(root=APPSTORE_ROOT):
    """locale -> its listing.md"""
    found = {"en-US": os.path.join(root, "listing.md")} if os.path.isfile(os.path.join(root, "listing.md")) else {}
    for d in sorted(os.listdir(root)):
        if os.path.isfile(os.path.join(root, d, "listing.md")):
            found[d] = os.path.join(root, d, "listing.md")
    return found


def next_version(versions):
    """The patch after the highest X.Y.Z"""
    top = max((tuple(int(p) for p in v.split(".")) + (0, 0))[:3] for v in versions) if versions else (1, 0, -1)
    return f"{top[0]}.{top[1]}.{top[2] + 1}"


def play(dry):
    import play as p
    token = p.access_token()
    edits = p.ROOT + f"androidpublisher/v3/applications/{os.environ['PLAY_PACKAGE']}/edits"

    def call(method, url, body=b"", content_type="application/json"):
        for attempt in range(5):
            request = urllib.request.Request(url, body, method=method, headers={"Authorization": "Bearer " + token, "Content-Type": content_type})
            try:
                with urllib.request.urlopen(request, timeout=300) as response:
                    return json.loads(response.read() or b"{}")
            except urllib.error.HTTPError as e:
                # Play answers 503 now and then, more so with dozens of image calls in one edit
                if e.code < 500 or attempt == 4:
                    # a call that timed out or got a 5xx may still have gone through (a commit then answers 4xx)
                    sys.exit(f"{method} {url.split('?')[0]}: {e.code} {e.read().decode()}"
                             + (" (an earlier try may have gone through: check Play Console)" if attempt else ""))
                print(f"{method} {url.split('?')[0]}: {e.code}, trying again")
            except OSError as e:  # dropped connections and timeouts (URLError is an OSError)
                if attempt == 4:
                    sys.exit(f"{method} {url.split('?')[0]}: {e}")
                print(f"{method} {url.split('?')[0]}: {e}, trying again")
            time.sleep(5 * 2 ** attempt)

    def shas(language, kind):
        return [i.get("sha256") for i in call("GET", f"{edits}/{edit}/listings/{language}/{kind}").get("images", [])]

    edit = call("POST", edits, b"{}")["id"]
    current = {listing["language"]: listing for listing in call("GET", f"{edits}/{edit}/listings").get("listings", [])}
    changed = 0
    for language in sorted(os.listdir(PLAY_ROOT)):
        folder = os.path.join(PLAY_ROOT, language)
        if not os.path.isfile(os.path.join(folder, "title.txt")):
            continue
        listing = {"language": language, **{k: open(os.path.join(folder, f), encoding="utf-8").read().strip()
                                              for k, f in PLAY_TEXTS.items() if os.path.isfile(os.path.join(folder, f))}}
        old = current.get(language, {})
        if any(old.get(k) != v for k, v in listing.items()):
            print(f"{language}: {'update' if old else 'add'} the listing ({listing['title']})")
            # PUT replaces the whole listing, so a promo video set in Play Console goes along
            body = dict(listing, video=old["video"]) if old.get("video") else listing
            call("PUT", f"{edits}/{edit}/listings/{language}", json.dumps(body).encode())
            changed += 1
        for kind, pattern in PLAY_IMAGES.items():
            files = images(os.path.join(folder, "images", pattern))
            if not files:
                continue
            want = [digest(f) for f in files]
            if shas(language, kind) == want:
                continue
            print(f"{language}: {kind} becomes {len(files)} image{'s' if len(files) > 1 else ''}")
            # an upload retried after a 5xx may have landed the first time too, so the set is checked and redone once
            for attempt in range(2):
                call("DELETE", f"{edits}/{edit}/listings/{language}/{kind}", None)
                for f in files:
                    call("POST", edits.replace(p.ROOT, p.ROOT + "upload/") + f"/{edit}/listings/{language}/{kind}?uploadType=media",
                         open(f, "rb").read(), TYPES[os.path.splitext(f)[1].lower()])
                if shas(language, kind) == want:
                    break
                if attempt:
                    sys.exit(f"{language}: Play's {kind} don't match the files after uploading them twice")
                print(f"{language}: {kind} don't match the files, uploading them again")
            changed += 1
    if not changed:
        call("DELETE", f"{edits}/{edit}", None)
        print("Play listings are up to date")
    elif dry:
        call("POST", f"{edits}/{edit}:validate")
        call("DELETE", f"{edits}/{edit}", None)
        print(f"Play accepts {changed} change{'s' if changed != 1 else ''}; nothing was sent (dry run)")
    else:
        # A release or listing still in review makes this fail rather than withdrawing it (Play's default cancels the review)
        call("POST", f"{edits}/{edit}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW")
        print(f"{changed} Play listing change{'s' if changed != 1 else ''} sent to review")


class OutOfTime(Exception):
    pass


def upload_screenshots(a, localization, display, files, say, dry, processing):
    """Makes the locale's set for this display type exactly these files, in this order. A set Apple still has to process
    goes into processing (its id) for wait_for_processing, which runs once every set is sent"""
    sets = {s["attributes"]["screenshotDisplayType"]: s for s in a.data("GET", f"/v1/appStoreVersionLocalizations/{localization}/appScreenshotSets")}
    shots = a.data("GET", f"/v1/appScreenshotSets/{sets[display]['id']}/appScreenshots") if display in sets else []
    # a screenshot Apple failed to process keeps its checksum, so it counts as different
    if ([s["attributes"].get("sourceFileChecksum") for s in shots] == [digest(f, "md5") for f in files]
            and not any(shot_state(s) == "FAILED" for s in shots)):
        if all(shot_state(s) == "COMPLETE" for s in shots):
            print("  up to date")
        else:  # sent by an earlier run that stopped waiting
            print("  up to date, Apple is still processing it")
            processing.append(sets[display]["id"])
        return
    say(f"  {len(files)} screenshots replace {len(shots)}")
    if dry:
        return
    # checked before the old ones go, so a set is never left half done
    if not time_for(SHOT_MINUTES):
        raise OutOfTime()
    if display in sets:
        shot_set = sets[display]["id"]
        for s in shots:
            a.api("DELETE", f"/v1/appScreenshots/{s['id']}")
    else:
        shot_set = a.data("POST", "/v1/appScreenshotSets", body=a.resource("appScreenshotSets", attributes={"screenshotDisplayType": display},
                          appStoreVersionLocalization={"type": "appStoreVersionLocalizations", "id": localization}))["id"]
    for f in files:
        raw = open(f, "rb").read()
        shot = a.data("POST", "/v1/appScreenshots", body=a.resource("appScreenshots", attributes={"fileName": os.path.basename(f), "fileSize": len(raw)},
                      appScreenshotSet={"type": "appScreenshotSets", "id": shot_set}))
        for op in shot["attributes"]["uploadOperations"]:
            for attempt in range(5):
                part = urllib.request.Request(op["url"], raw[op["offset"]:op["offset"] + op["length"]], method=op["method"],
                                              headers={h["name"]: h["value"] for h in op.get("requestHeaders", [])})
                try:
                    urllib.request.urlopen(part, timeout=300).read()
                    break
                except OSError as e:  # HTTPError and URLError are OSErrors too; a part PUT can be sent again
                    if attempt == 4 or (isinstance(e, urllib.error.HTTPError) and e.code < 500):
                        sys.exit(f"{os.path.basename(f)}: uploading a part failed: {e}")
                    print(f"  {os.path.basename(f)}: {e}, trying the part again")
                    time.sleep(5 * 2 ** attempt)
        a.data("PATCH", f"/v1/appScreenshots/{shot['id']}", body=a.resource("appScreenshots", shot["id"], {"uploaded": True, "sourceFileChecksum": digest(f, "md5")}))
    processing.append(shot_set)


def wait_for_processing(a, processing):
    """App Review takes the version right after this, so the sets sent have to be processed first. Apple processes them side
    by side, at times taking well over 10 minutes for one, so every set is sent before any is waited for; the wait lasts
    until --until, or PROCESS_MINUTES without it. It checks one set at a time (the next once that one is done), so a long
    wait stays well inside the key's 3600 requests an hour, and a rate limit or a server error only means asking again"""
    deadline = UNTIL or time.time() + PROCESS_MINUTES * 60
    if processing:
        print(f"Waiting for Apple to process {len(processing)} screenshot set{'s' if len(processing) != 1 else ''}")
    while processing:
        try:
            shots = a.data("GET", f"/v1/appScreenshotSets/{processing[0]}/appScreenshots", ok=(429, 500, 502, 503, 504))
        except (OSError, http.client.HTTPException) as e:  # a dropped connection, over a wait this long
            print(f"  {e!r}, asking again")
            shots = None
        states = [shot_state(s) for s in shots or []]
        if "FAILED" in states:
            sys.exit(f"  Apple couldn't process a screenshot in set {processing[0]}: {states}")
        if shots is not None and all(s == "COMPLETE" for s in states):
            processing.pop(0)
            continue
        if time.time() + 15 > deadline:
            sys.exit(f"  {len(processing)} screenshot sets weren't processed in time (running this again waits for them): {processing}")
        time.sleep(15)


def shot_state(shot):
    return (shot["attributes"].get("assetDeliveryState") or {}).get("state")


def time_for(minutes):
    """Whether --until leaves this many minutes"""
    return UNTIL is None or time.time() + minutes * 60 <= UNTIL


def cancel_review(a, version, build, say, dry):
    """What appstore.py does before it submits: once the new build has processed, cancel the submission waiting or in
    review, which hands its version back for editing. Returns the versions afterwards (in a dry run, as they are)."""
    # as appstore.py: nothing is cancelled for a build that won't make it to review
    query = {"filter[app]": a.APP, "filter[version]": build, "filter[preReleaseVersion.version]": version}
    for attempt in range(120):
        builds = a.data("GET", "/v1/builds", query)
        state = builds[0]["attributes"]["processingState"] if builds else "NOT_FOUND"
        if state == "VALID" or dry: break
        if state in ("FAILED", "INVALID"): sys.exit(f"Build {version} ({build}) is {state}")
        if not time_for(0): sys.exit(f"Out of time waiting for build {version} ({build}): nothing was cancelled or sent")
        print(f"Build {version} ({build}): {state}, waiting")
        time.sleep(30)
    else:
        sys.exit("The build didn't finish processing within an hour")
    for submission in a.data("GET", "/v1/reviewSubmissions", {"filter[app]": a.APP, "filter[platform]": "IOS", "filter[state]": ",".join(a.OPEN)}):
        say(f"Cancel the {submission['attributes']['state']} submission {submission['id']} (the release replaces it)")
        if not dry:
            a.data("PATCH", f"/v1/reviewSubmissions/{submission['id']}", body=a.resource("reviewSubmissions", submission["id"], {"canceled": True}))
    for attempt in range(40):  # cancelling takes a moment to reach the version
        all_versions = a.versions()
        if dry or any(v["attributes"]["appStoreState"] in a.EDITABLE for v in all_versions) \
                or not any(v["attributes"]["appStoreState"] in a.REVIEWING for v in all_versions):
            return all_versions
        time.sleep(15)
    sys.exit("The cancelled version didn't become editable within 10 minutes")


def appstore(version_string, dry, release=None):
    """release: the build number a release is about to submit"""
    import appstore as a
    say = (lambda text: print("Would " + text[0].lower() + text[1:])) if dry else print
    # a release submits right after this, replacing what's in review, so the listing goes on that version now
    all_versions = cancel_review(a, version_string, release, say, dry) if release else a.versions()
    availability = (a.data("GET", f"/v1/apps/{a.APP}/appAvailabilityV2", ok=(403, 404)) or {}).get("id")
    if availability:
        where = a.data("GET", f"/v2/appAvailabilities/{availability}/territoryAvailabilities", {"include": "territory", "limit": 200}, ok=(403, 404)) or []
        on = {t["relationships"]["territory"]["data"]["id"] for t in where if t["attributes"].get("available")}
        print(f"On sale in {len(on)} of {len(where)} territories; China mainland {'included' if 'CHN' in on else 'left out'}")
    version = next((v for v in all_versions if v["attributes"]["appStoreState"] in a.EDITABLE), None)
    pending = next((v for v in all_versions if v["attributes"]["appStoreState"] in a.OPEN), None)
    if not version and pending and release and dry:
        version = pending  # what a real release would have cancelled and edited
    elif not version and pending:
        # A version waiting for or in review is locked: what's sent now would wait for the one after it
        print(f"::warning::Version {pending['attributes']['versionString']} is {pending['attributes']['appStoreState']}, so its listing "
              "can't change; run this again once Apple is done with it, or release (a release replaces it and sends the listing)")
        return
    if not version:
        version_string = version_string or next_version([v["attributes"]["versionString"] for v in all_versions])
        say(f"Start version {version_string}, which the next release takes over")
        if dry:
            return
        version = a.data("POST", "/v1/appStoreVersions", body=a.resource(
            "appStoreVersions", attributes={"platform": "IOS", "versionString": version_string, "releaseType": "AFTER_APPROVAL"},
            app={"type": "apps", "id": a.APP}))
    print(f"Version {version['attributes']['versionString']} ({version['attributes']['appStoreState']})")
    # The app info being edited is the one that isn't live yet
    infos = a.data("GET", f"/v1/apps/{a.APP}/appInfos")
    live = {"READY_FOR_DISTRIBUTION", "READY_FOR_SALE", "ACCEPTED", "REPLACED_WITH_NEW_INFO"}
    info = next((i for i in infos if i["attributes"].get("state", i["attributes"].get("appStoreState")) not in live), infos[0])
    rating = a.data("GET", f"/v1/appInfos/{info['id']}/ageRatingDeclaration") or {}
    if rating.get("attributes", {}).get("socialMedia") is None:
        print("::warning::The age rating doesn't answer socialMedia yet: App Review rejects the submission until it does")
    listings = {locale: sections(path) for locale, path in appstore_locales().items()}
    targets = (("appStoreVersionLocalizations", f"/v1/appStoreVersions/{version['id']}/appStoreVersionLocalizations", VERSION_TEXTS,
                ("supportUrl", "marketingUrl"), {"appStoreVersion": {"type": "appStoreVersions", "id": version["id"]}}),
               ("appInfoLocalizations", f"/v1/appInfos/{info['id']}/appInfoLocalizations", INFO_TEXTS,
                ("privacyPolicyUrl",), {"appInfo": {"type": "appInfos", "id": info["id"]}}))
    for kind, path, names, copied, parent in targets:
        existing = {l["attributes"]["locale"]: l for l in a.data("GET", path, {"limit": 200})}
        base = existing.get("en-US") or next(iter(existing.values()), {"attributes": {}})
        for locale, texts in listings.items():
            fields = {attribute: texts[section] for attribute, section in names.items() if texts.get(section)}
            old = existing.get(locale)
            if old and all(old["attributes"].get(k) == v for k, v in fields.items()):
                continue
            say(f"{'Update' if old else 'Add'} {locale} {', '.join(fields)}")
            if dry:
                continue
            if old:
                a.data("PATCH", f"/v1/{kind}/{old['id']}", body=a.resource(kind, old["id"], fields))
            else:
                fields.update({k: base["attributes"][k] for k in copied if base["attributes"].get(k)})
                existing[locale] = a.data("POST", f"/v1/{kind}", body=a.resource(kind, attributes=dict(fields, locale=locale), **parent))
        if kind == "appStoreVersionLocalizations":
            localizations = existing
    # screenshots last: they take the longest, so running out of time leaves only them behind; every locale's iPhone set
    # goes before the iPad ones
    processing = []
    try:
        for folder, (display, device) in DISPLAYS.items():
            for locale in listings:
                files = images(os.path.join(SHOTS_ROOT, locale, folder, "*"))
                if not files:
                    continue
                if locale not in localizations:
                    say(f"{locale}: upload {len(files)} {device} screenshots once the localization exists")
                    continue
                print(f"{locale} {device} screenshots:")
                upload_screenshots(a, localizations[locale]["id"], display, files, say, dry, processing)
    except OutOfTime:
        # said before the wait, which near the deadline usually runs out of time too; flushed, as that exit goes to stderr
        print("  Out of time: this set and the ones after it keep their screenshots until the next release or Listings run", flush=True)
        wait_for_processing(a, processing)
        sys.exit(1)
    if not dry:
        wait_for_processing(a, processing)


def main():
    global UNTIL
    args = [x for x in sys.argv[1:] if x != "--dry-run"]
    dry = "--dry-run" in sys.argv
    if "--until" in args:
        UNTIL = int(args[args.index("--until") + 1])
    if not args or args[0] not in ("play", "appstore"):
        sys.exit(__doc__)
    if args[0] == "play":
        play(dry)
    else:
        release = args[args.index("--release") + 1] if "--release" in args else None
        if release and "--version" not in args:
            sys.exit("--release <build number> needs --version")
        appstore(args[args.index("--version") + 1] if "--version" in args else None, dry, release)


if __name__ == "__main__":
    main()
