"""Checks for the shared release scripts: python3 -m unittest discover -s .github/scripts"""
import contextlib, hashlib, io, json, os, subprocess, sys, tempfile, unittest
from unittest import mock

os.environ.setdefault("APP_STORE_APP_ID", "1")
os.environ.setdefault("ASC_KEY_ID", "KEY")
os.environ.setdefault("ASC_ISSUER_ID", "issuer")
sys.path.insert(0, os.path.dirname(__file__))
import appstore, fdroid, listings, notes
IPHONE, IPAD = listings.DISPLAYS[""][0], listings.DISPLAYS["ipad-13"][0]


class FakeStore:
    """App Store Connect for listings.appstore: versions, one app info, localizations and screenshots, recording writes"""
    def __init__(self, versions, localizations=None, shots=None, build="VALID"):
        self.build = build
        self.versions = [{"id": i, "attributes": {"versionString": s, "appStoreState": state}} for i, s, state in versions]
        self.localizations = {locale: {"id": "loc-" + locale, "attributes": dict(a, locale=locale)} for locale, a in (localizations or {}).items()}
        self.writes, self.uploaded, self.count = [], [], 0
        # screenshot sets by display type, the set's id too: the 6.9" one already on the store, as (checksum, processing
        # state); new uploads join their set, processed
        self.sets = {IPHONE: [{"id": f"old-{n}", "attributes": {"sourceFileChecksum": c, "assetDeliveryState": {"state": s}}}
                              for n, (c, s) in enumerate(shots)]} if shots else {}
        self.submissions = [{"id": "sub", "attributes": {"state": v["attributes"]["appStoreState"]}}
                            for v in self.versions if v["attributes"]["appStoreState"] in appstore.OPEN]

    def data(self, method, path, query=None, body=None, ok=()):
        if method != "GET":
            self.writes.append((method, path, body))
            self.count += 1
            new = {"id": f"new-{self.count}", "attributes": dict(body["data"].get("attributes", {})) if body else {}}
            if path == "/v1/appStoreVersions":
                new["attributes"]["appStoreState"] = "PREPARE_FOR_SUBMISSION"
            if path == "/v1/appScreenshotSets":
                new["id"] = new["attributes"]["screenshotDisplayType"]
                self.sets[new["id"]] = []
            if path == "/v1/appScreenshots":
                new["attributes"]["uploadOperations"] = [{"method": "PUT", "url": f"https://upload/{self.count}", "offset": 0,
                                                          "length": new["attributes"]["fileSize"], "requestHeaders": []}]
                self.sets[body["data"]["relationships"]["appScreenshotSet"]["data"]["id"]].append(new)
            if method == "DELETE" and path.startswith("/v1/appScreenshots/"):
                self.sets = {d: [s for s in shots if s["id"] != path.split("/")[-1]] for d, shots in self.sets.items()}
            if method == "PATCH" and path.startswith("/v1/appScreenshots/"):
                shot = next(s for shots in self.sets.values() for s in shots if s["id"] == path.split("/")[-1])
                shot["attributes"].update(body["data"]["attributes"], assetDeliveryState={"state": "COMPLETE"})
            if method == "PATCH" and path.startswith("/v1/reviewSubmissions/"):  # cancelling hands the version back
                self.submissions = []
                for v in self.versions:
                    if v["attributes"]["appStoreState"] in appstore.OPEN: v["attributes"]["appStoreState"] = "DEVELOPER_REJECTED"
            return new
        if path == "/v1/reviewSubmissions":
            return self.submissions
        if path == "/v1/builds":
            return [{"id": "b", "attributes": {"processingState": self.build}}]
        if path.endswith("/appScreenshotSets"):
            return [{"id": d, "attributes": {"screenshotDisplayType": d}} for d in self.sets]
        if path.endswith("/appScreenshots"):
            return self.sets[path.split("/")[-2]]
        if path.endswith("/appStoreVersions"):
            return self.versions
        if path.endswith("/appAvailabilityV2"):
            return {"id": "avail"}
        if path.endswith("/territoryAvailabilities"):
            return [{"attributes": {"available": t != "CHN"}, "relationships": {"territory": {"data": {"id": t}}}} for t in ("USA", "CHN")]
        if path.endswith("/appInfos"):
            return [{"id": "info", "attributes": {"state": "PREPARE_FOR_SUBMISSION"}}]
        if path.endswith("/ageRatingDeclaration"):
            return {"attributes": {"socialMedia": False}}
        if path.endswith("/appStoreVersionLocalizations"):
            return list(self.localizations.values())
        return []  # no app info localizations, screenshot sets or screenshots yet

    def api(self, method, path, query=None, body=None, ok=()):
        return {"data": self.data(method, path, query, body=body, ok=ok)}

    def urlopen(self, request, timeout=None):
        self.uploaded.append(request.data)
        return mock.MagicMock()

    def __enter__(self):
        self.patches = [mock.patch.object(appstore, "data", self.data), mock.patch.object(appstore, "api", self.api),
                        mock.patch.object(appstore, "versions", lambda: self.versions),
                        mock.patch.object(listings.urllib.request, "urlopen", self.urlopen)]
        for p in self.patches: p.start()
        return self

    def __exit__(self, *exc):
        for p in self.patches: p.stop()


class FakePlay:
    """The Play edits API for listings.play, one language; the first image upload lands but answers 503, as Play now
    and then does, so a naive retry would leave it in twice"""
    def __init__(self, listings=()):
        self.images, self.calls, self.urls, self.flaky, self.listings, self.bodies = {}, [], [], True, list(listings), []

    def urlopen(self, request, timeout=None):
        method, url = request.get_method(), request.full_url.split("?")[0]
        self.calls.append((method, url.split("/edits")[-1]))
        self.urls.append(request.full_url)
        answer = {}
        if method == "POST" and url.endswith("/edits"):
            answer = {"id": "e"}
        elif method == "GET" and url.endswith("/listings"):
            answer = {"listings": self.listings}
        elif method == "PUT" and "/listings/" in url:
            self.bodies.append(json.loads(request.data))
        elif "/listings/" in url and url.rsplit("/", 1)[-1] in listings.PLAY_IMAGES:
            kind = url.rsplit("/", 1)[-1]
            if method == "GET":
                answer = {"images": [{"sha256": s} for s in self.images.get(kind, [])]}
            elif method == "DELETE":
                self.images[kind] = []
            elif method == "POST":
                self.images.setdefault(kind, []).append(hashlib.sha256(request.data).hexdigest())
                if self.flaky:
                    self.flaky = False
                    raise listings.urllib.error.HTTPError(url, 503, "Service Unavailable", {}, None)
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(answer).encode()
        return response

METADATA = """AutoName: Mesh+

RepoType: git
Repo: https://github.com/backmeupplz/meshtastic-plus.git
Binaries:
  https://github.com/backmeupplz/meshtastic-plus/releases/download/v%v/meshplus.apk

Builds:
  - versionName: 0.4.3
    versionCode: 7
    commit: 793ee7cd8fe0103fb4857c13a73bc0c4af1a8926
    subdir: app
    gradle:
      - fdroid

AllowedAPKSigningKeys: 9216a9c3839474e6d9702f93baa0f4b7c26be5f606606c32d806f23ce91977a8

AutoUpdateMode: Version
UpdateCheckMode: Tags
CurrentVersion: 0.4.3
CurrentVersionCode: 7
""".replace("Binaries:\n", "Binaries: \n")  # rewritemeta leaves a space after Binaries:

# metadata/com.todorant.yml on the fork's com.todorant branch, 2026-10-16
TODORANT = """Categories:
  - Task
License: MPL-2.0
AuthorName: borodutch
WebSite: https://todorant.com
SourceCode: https://github.com/backmeupplz/todorant
IssueTracker: https://github.com/backmeupplz/todorant/issues

AutoName: Todorant

RepoType: git
Repo: https://github.com/backmeupplz/todorant.git
Binaries:
  https://github.com/backmeupplz/todorant/releases/download/android-v%v/todorant-fdroid-%v.apk

Builds:
  - versionName: 2.2.4
    versionCode: 5000006
    commit: b3ae215ce4916d7a669ed3350a4b622964b1d153
    subdir: android/app
    gradle:
      - fdroid

AllowedAPKSigningKeys: c9c7aa8d153d7e7d16b5848b320448e82a565ff9cd761e8ecf1734558ee90731

AutoUpdateMode: Version
UpdateCheckMode: Tags ^android-v
CurrentVersion: 2.2.4
CurrentVersionCode: 5000006
""".replace("Binaries:\n", "Binaries: \n")


class Scripts(unittest.TestCase):
    def test_fdroid_rewrite_touches_only_the_version_lines(self):
        new = fdroid.rewrite(METADATA, "0.4.4", "8", "662f13bb36d7ccd19f5813a06b0f89729ceb4ad2")
        changed = [(a, b) for a, b in zip(METADATA.splitlines(), new.splitlines()) if a != b]
        self.assertEqual([b for a, b in changed], [
            "  - versionName: 0.4.4", "    versionCode: 8", "    commit: 662f13bb36d7ccd19f5813a06b0f89729ceb4ad2",
            "CurrentVersion: 0.4.4", "CurrentVersionCode: 8"])
        self.assertIn("Binaries: \n  https://", new)  # rewritemeta's wrapping survives

    def test_fdroid_quotes_versions_yaml_would_read_as_numbers(self):
        self.assertIn("  - versionName: '1.3'\n", fdroid.rewrite(METADATA, "1.3", "9", "a" * 40))

    def test_fdroid_refuses_more_than_one_build(self):
        with self.assertRaises(SystemExit):
            fdroid.rewrite(METADATA.replace("Builds:\n", "Builds:\n  - versionName: 0.4.2\n    versionCode: 6\n"), "0.4.4", "8", "a" * 40)

    def test_fdroid_moves_todorant_to_v_tags(self):
        new = fdroid.rewrite(TODORANT, "2.2.5", "5000007", "b" * 40, "Tags ^v",
                             "https://github.com/backmeupplz/todorant/releases/download/v%v/todorant-fdroid-%v.apk")
        self.assertIn("\nBinaries: \n  https://github.com/backmeupplz/todorant/releases/download/v%v/todorant-fdroid-%v.apk\n\nBuilds:", new)
        self.assertIn("\nUpdateCheckMode: Tags ^v\nCurrentVersion: 2.2.5\nCurrentVersionCode: 5000007\n", new)
        self.assertEqual(len(new.splitlines()), len(TODORANT.splitlines()))

    def test_fdroid_binaries_wrap_like_rewritemeta(self):
        # rewritemeta (fdroidserver 2.4.2, ruamel.yaml 0.18.10) wraps values over 80 characters: Mesh+'s 81, not ABS+'s 75
        for url, wrapped in (("https://github.com/backmeupplz/meshtastic-plus/releases/download/v%v/meshplus.apk", True),
                             ("https://github.com/backmeupplz/absplus/releases/download/v%v/absplus-%v.apk", False),
                             ("x" * 80, False), ("x" * 81, True)):
            new = fdroid.rewrite(METADATA, "0.4.3", "7", "793ee7cd8fe0103fb4857c13a73bc0c4af1a8926", binaries=url)
            self.assertIn(("Binaries: \n  " if wrapped else "Binaries: ") + url + "\n\nBuilds:", new)

    def test_fdroid_same_values_change_nothing(self):
        self.assertEqual(fdroid.rewrite(METADATA, "0.4.3", "7", "793ee7cd8fe0103fb4857c13a73bc0c4af1a8926", "Tags",
                                        "https://github.com/backmeupplz/meshtastic-plus/releases/download/v%v/meshplus.apk"), METADATA)

    def test_notes_per_language_fall_back_to_english(self):
        with tempfile.TemporaryDirectory() as root:
            def write(folder, text):
                os.makedirs(os.path.join(root, folder, "changelogs"), exist_ok=True)
                with open(os.path.join(root, folder, "changelogs", "7.txt"), "w") as f: f.write(text)
            write("en-US", "Faster sync.\n")
            write("de-DE", "Schnellere Synchronisierung.\n")
            write("zh-CN", "同步更快。")
            write("es-419", "Sincronización más rápida.")
            write("fr-FR", "  \n")  # empty: the English
            english = os.path.join(root, "en-US", "changelogs", "7.txt")
            self.assertEqual(notes.read(english, "de-DE", 500), "Schnellere Synchronisierung.")
            self.assertEqual(notes.read(english, "zh-Hans", 4000), "同步更快。")  # App Store locale -> Play folder
            self.assertEqual(notes.read(english, "es-MX", 4000), "Sincronización más rápida.")
            self.assertEqual(notes.read(english, "fr-FR", 500), "Faster sync.")
            self.assertEqual(notes.read(english, "ja", 4000), "Faster sync.")  # no folder
            self.assertEqual(notes.read(english, "de-DE", 10), "Schnellere")
            self.assertEqual(notes.path(english, "en-US"), english)

    def test_listing_sections_and_versions(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "de-DE"))
            os.makedirs(os.path.join(root, "screenshots"))  # no listing.md: not a locale
            with open(os.path.join(root, "listing.md"), "w") as f:
                f.write("# App Store listing (en-US)\n\n## Name (max 30)\nQuilcast\n\n## Description (max 4000)\nOne.\n\nTwo.\n\n## URLs\n- x\n")
            with open(os.path.join(root, "de-DE", "listing.md"), "w") as f:
                f.write("## Name\nQuilcast DE\n")
            self.assertEqual(listings.appstore_locales(root), {"en-US": os.path.join(root, "listing.md"), "de-DE": os.path.join(root, "de-DE", "listing.md")})
            self.assertEqual(listings.sections(os.path.join(root, "listing.md")), {"Name": "Quilcast", "Description": "One.\n\nTwo.", "URLs": "- x"})
        self.assertEqual(listings.next_version(["1.0.0", "0.9.12", "1.0"]), "1.0.1")
        self.assertEqual(listings.next_version([]), "1.0.0")

    def test_listings_wait_for_a_version_in_review(self):
        store = FakeStore([("v1", "1.0.0", "WAITING_FOR_REVIEW")])
        with store:
            listings.appstore("1.0.1", False)
        self.assertEqual(store.writes, [])

    def test_listings_start_the_next_version_and_fill_every_locale(self):
        store = FakeStore([("v1", "1.0.0", "READY_FOR_SALE")], {"en-US": {"supportUrl": "https://s", "description": "Old"}})
        with tempfile.TemporaryDirectory() as root, store:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                os.makedirs("appstore/de-DE")
                os.makedirs("appstore/screenshots/de-DE")
                with open("appstore/listing.md", "w") as f: f.write("## Name\nQuilcast\n## Description\nOld\n")
                with open("appstore/de-DE/listing.md", "w") as f: f.write("## Name\nQuilcast\n## Subtitle\nFarcaster-Client\n## Description\nNeu\n")
                for n in (1, 2):
                    with open(f"appstore/screenshots/de-DE/{n}.jpg", "wb") as f: f.write(b"jpeg %d" % n)
                listings.appstore(None, True)
                self.assertEqual(store.writes, [])  # a dry run sends nothing
                listings.appstore("1.0.1", False)
            finally:
                os.chdir(cwd)
        kinds = [(method, path.split("/")[2]) for method, path, _ in store.writes]
        self.assertEqual(kinds[0], ("POST", "appStoreVersions"))
        self.assertEqual(store.writes[0][2]["data"]["attributes"]["versionString"], "1.0.1")
        added = [body["data"]["attributes"] for method, path, body in store.writes if path == "/v1/appStoreVersionLocalizations"]
        self.assertEqual(added, [{"description": "Neu", "locale": "de-DE", "supportUrl": "https://s"}])  # en-US was already right
        self.assertEqual([body["data"]["attributes"]["fileName"] for method, path, body in store.writes if path == "/v1/appScreenshots"], ["1.jpg", "2.jpg"])
        self.assertEqual(store.uploaded, [b"jpeg 1", b"jpeg 2"])
        done = [body["data"]["attributes"] for method, path, body in store.writes if method == "PATCH" and "appScreenshots/" in path]
        self.assertEqual([d["sourceFileChecksum"] for d in done], [hashlib.md5(b"jpeg 1").hexdigest(), hashlib.md5(b"jpeg 2").hexdigest()])

    def test_a_release_cancels_the_review_and_puts_the_listing_on_that_version(self):
        store = FakeStore([("v1", "1.0.0", "WAITING_FOR_REVIEW")], {"en-US": {"description": "Old"}})
        with tempfile.TemporaryDirectory() as root, store:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                os.makedirs("appstore")
                with open("appstore/listing.md", "w") as f: f.write("## Name\nQuilcast\n## Description\nNew\n")
                listings.appstore("1.0.1", True, release="2")
                self.assertEqual(store.writes, [])  # a dry run sends nothing
                listings.appstore("1.0.1", False, release="2")
            finally:
                os.chdir(cwd)
        self.assertEqual(store.writes[0][1], "/v1/reviewSubmissions/sub")
        self.assertEqual(store.writes[0][2]["data"]["attributes"], {"canceled": True})
        self.assertIn(("PATCH", "/v1/appStoreVersionLocalizations/loc-en-US", {"description": "New"}),
                      [(m, p, b["data"]["attributes"]) for m, p, b in store.writes])
        self.assertNotIn("/v1/appStoreVersions", [p for m, p, b in store.writes])  # the cancelled version, not a new one

    def test_a_release_with_a_broken_build_cancels_nothing(self):
        store = FakeStore([("v1", "1.0.0", "WAITING_FOR_REVIEW")], build="INVALID")
        with store, self.assertRaises(SystemExit):
            listings.appstore("1.0.1", False, release="2")
        self.assertEqual(store.writes, [])

    def test_a_release_out_of_time_waiting_for_the_build_cancels_nothing(self):
        store = FakeStore([("v1", "1.0.0", "WAITING_FOR_REVIEW")], build="PROCESSING")
        with store, mock.patch.object(listings, "UNTIL", 0), mock.patch.object(listings.time, "sleep"), self.assertRaises(SystemExit):
            listings.appstore("1.0.1", False, release="2")
        self.assertEqual(store.writes, [])

    def test_app_review_out_of_time_waiting_for_the_build_cancels_nothing(self):
        store = FakeStore([("v1", "1.0.0", "WAITING_FOR_REVIEW")], build="PROCESSING")
        with store, mock.patch.dict(os.environ, {"SUBMIT_UNTIL": "1"}), mock.patch.object(appstore.time, "sleep"), \
                mock.patch.object(sys, "argv", ["appstore.py", "1.0.1", "2", "notes.txt"]), self.assertRaises(SystemExit):
            appstore.main()
        self.assertEqual(store.writes, [])

    def test_a_release_out_of_time_sends_the_texts_and_leaves_the_screenshots(self):
        store = FakeStore([("v1", "1.0.0", "WAITING_FOR_REVIEW")], {"en-US": {"description": "Old"}})
        with tempfile.TemporaryDirectory() as root, store:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                os.makedirs("appstore/screenshots/en-US")
                with open("appstore/listing.md", "w") as f: f.write("## Name\nQuilcast\n## Description\nNew\n")
                with open("appstore/screenshots/en-US/1.jpg", "wb") as f: f.write(b"jpeg 1")
                # 10 minutes left: enough to cancel and send the texts, not a locale's screenshots
                with mock.patch.object(listings, "UNTIL", listings.time.time() + 600), self.assertRaises(SystemExit):
                    listings.appstore("1.0.1", False, release="2")
            finally:
                os.chdir(cwd)
        paths = [p for m, p, b in store.writes]
        self.assertEqual(paths[0], "/v1/reviewSubmissions/sub")
        self.assertIn("/v1/appStoreVersionLocalizations/loc-en-US", paths)
        self.assertIn("/v1/appInfoLocalizations", paths)  # the name went too, before the screenshots
        self.assertFalse([p for p in paths if "Screenshot" in p])
        self.assertEqual(store.uploaded, [])

    def test_a_screenshot_apple_failed_to_process_is_uploaded_again(self):
        with tempfile.TemporaryDirectory() as root:
            shot = os.path.join(root, "1.jpg")
            with open(shot, "wb") as f: f.write(b"jpeg 1")
            md5 = hashlib.md5(b"jpeg 1").hexdigest()
            say = lambda text: None
            with FakeStore([], shots=[(md5, "COMPLETE")]) as store, contextlib.redirect_stdout(io.StringIO()):
                processing = []
                listings.upload_screenshots(appstore, "loc", IPHONE, [shot], say, False, processing)
                self.assertEqual((store.uploaded, processing), ([], []))
            with FakeStore([], shots=[(md5, "FAILED")]) as store:
                processing = []
                listings.upload_screenshots(appstore, "loc", IPHONE, [shot], say, False, processing)
                self.assertEqual([s["attributes"]["assetDeliveryState"]["state"] for s in store.sets[IPHONE]], ["COMPLETE"])
                self.assertEqual(store.uploaded, [b"jpeg 1"])
                self.assertEqual(processing, [IPHONE])

    def test_a_set_apple_is_still_processing_is_waited_for_not_sent_again(self):
        with tempfile.TemporaryDirectory() as root:
            shot = os.path.join(root, "1.jpg")
            with open(shot, "wb") as f: f.write(b"jpeg 1")
            with FakeStore([], shots=[(hashlib.md5(b"jpeg 1").hexdigest(), "UPLOAD_COMPLETE")]) as store, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                processing = []
                listings.upload_screenshots(appstore, "loc", IPHONE, [shot], lambda text: None, False, processing)
                self.assertEqual((store.uploaded, processing), ([], [IPHONE]))
                self.assertIn("up to date, Apple is still processing it", out.getvalue())
                # 20 minutes of processing, longer than the old 10-minute limit
                clock = [0]
                def sleep(seconds):
                    clock[0] += seconds
                    if clock[0] >= 20 * 60:
                        store.sets[IPHONE][0]["attributes"]["assetDeliveryState"]["state"] = "COMPLETE"
                with mock.patch.object(listings.time, "sleep", sleep), mock.patch.object(listings.time, "time", lambda: clock[0]):
                    listings.wait_for_processing(appstore, processing)
                self.assertEqual(processing, [])
                self.assertEqual(clock[0], 20 * 60)

    def test_waiting_asks_one_set_at_a_time_and_again_after_a_rate_limit(self):
        done = [{"attributes": {"assetDeliveryState": {"state": "COMPLETE"}}}]
        # None: a 429 carried on past; then a dropped connection
        answers = {"a": [None, ConnectionResetError("reset"), done], "b": [done]}
        asked = []
        def data(method, path, query=None, ok=()):
            self.assertIn(429, ok)
            asked.append(path.split("/")[-2])
            answer = answers[asked[-1]].pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        with mock.patch.object(appstore, "data", data), mock.patch.object(listings.time, "sleep") as sleep, \
                contextlib.redirect_stdout(io.StringIO()):
            processing = ["a", "b"]
            listings.wait_for_processing(appstore, processing)
        self.assertEqual((asked, processing, sleep.call_count), (["a", "a", "a", "b"], [], 2))

    def test_waiting_stops_at_the_deadline_and_on_a_failed_screenshot(self):
        for state, message in (("UPLOAD_COMPLETE", "weren't processed in time"), ("FAILED", "couldn't process")):
            with FakeStore([], shots=[("md5", state)]), contextlib.redirect_stdout(io.StringIO()):
                clock = [0]
                def sleep(seconds): clock[0] += seconds
                with mock.patch.object(listings.time, "sleep", sleep), mock.patch.object(listings.time, "time", lambda: clock[0]), \
                        self.assertRaises(SystemExit) as stop:
                    listings.wait_for_processing(appstore, [IPHONE])
                self.assertIn(message, str(stop.exception))
                self.assertLessEqual(clock[0], listings.PROCESS_MINUTES * 60)

    def test_every_set_is_sent_before_any_is_waited_for(self):
        store = FakeStore([("v1", "1.0.1", "PREPARE_FOR_SUBMISSION")], {"en-US": {"description": "Old"}, "de-DE": {"description": "Alt"}})
        waits = []
        with tempfile.TemporaryDirectory() as root, store:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                for locale in ("en-US", "de-DE"):
                    os.makedirs(f"appstore/screenshots/{locale}")
                    with open(f"appstore/screenshots/{locale}/1.jpg", "wb") as f: f.write(locale.encode())
                os.makedirs("appstore/de-DE")
                with open("appstore/listing.md", "w") as f: f.write("## Name\nTodorant\n## Description\nOld\n")
                with open("appstore/de-DE/listing.md", "w") as f: f.write("## Name\nTodorant\n## Description\nAlt\n")
                real_wait = listings.wait_for_processing
                def wait(a, processing):
                    waits.append(list(store.uploaded))
                    real_wait(a, processing)
                with mock.patch.object(listings, "wait_for_processing", wait), contextlib.redirect_stdout(io.StringIO()):
                    listings.appstore(None, False)
            finally:
                os.chdir(cwd)
        self.assertEqual([sorted(uploaded) for uploaded in waits], [[b"de-DE", b"en-US"]])  # one wait, after both uploads

    def test_listings_sync_the_ipad_set_from_its_folder(self):
        store = FakeStore([("v1", "1.0.1", "PREPARE_FOR_SUBMISSION")], {"en-US": {"description": "Old"}},
                          shots=[(hashlib.md5(b"iphone 1").hexdigest(), "COMPLETE")])
        def shot_writes():
            return [(m, p) for m, p, b in store.writes if "Screenshot" in p]
        with tempfile.TemporaryDirectory() as root, store:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                os.makedirs("appstore/screenshots/en-US/ipad-13")
                with open("appstore/listing.md", "w") as f: f.write("## Name\nTodorant\n## Description\nOld\n")
                with open("appstore/screenshots/en-US/1.jpg", "wb") as f: f.write(b"iphone 1")
                for n in (1, 2):
                    with open(f"appstore/screenshots/en-US/ipad-13/{n}.jpg", "wb") as f: f.write(b"ipad %d" % n)
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    listings.appstore(None, True)
                self.assertEqual(shot_writes(), [])  # a dry run sends nothing, and shows the iPad set
                self.assertIn('en-US 6.9" iPhone screenshots:\n  up to date\nen-US 13" iPad screenshots:\nWould   2 screenshots replace 0',
                              out.getvalue())
                with contextlib.redirect_stdout(io.StringIO()):
                    listings.appstore(None, False)
                self.assertEqual(shot_writes()[0], ("POST", "/v1/appScreenshotSets"))
                self.assertEqual(store.writes[[p for m, p, b in store.writes].index("/v1/appScreenshotSets")][2]["data"]["attributes"],
                                 {"screenshotDisplayType": IPAD})
                self.assertEqual(store.uploaded, [b"ipad 1", b"ipad 2"])  # the iPhone set was already right
                self.assertEqual([s["attributes"]["sourceFileChecksum"] for s in store.sets[IPAD]],
                                 [hashlib.md5(b"ipad 1").hexdigest(), hashlib.md5(b"ipad 2").hexdigest()])
                sent = len(store.writes)
                with contextlib.redirect_stdout(io.StringIO()):
                    listings.appstore(None, False)
                self.assertFalse([p for m, p, b in store.writes[sent:] if "Screenshot" in p])  # both sets match now
            finally:
                os.chdir(cwd)

    def test_listings_send_every_iphone_set_before_the_ipad_ones(self):
        store = FakeStore([("v1", "1.0.1", "PREPARE_FOR_SUBMISSION")], {"en-US": {"description": "Old"}})
        with tempfile.TemporaryDirectory() as root, store:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                os.makedirs("appstore/screenshots/en-US/ipad-13")
                with open("appstore/listing.md", "w") as f: f.write("## Name\nTodorant\n## Description\nOld\n")
                with open("appstore/screenshots/en-US/1.jpg", "wb") as f: f.write(b"iphone 1")
                with open("appstore/screenshots/en-US/ipad-13/1.jpg", "wb") as f: f.write(b"ipad 1")
                # time for one set: the iPhone one goes, the iPad one waits for the next run
                with mock.patch.object(listings, "time_for", side_effect=[True, False]), contextlib.redirect_stdout(io.StringIO()) as out, \
                        self.assertRaises(SystemExit) as stop:
                    listings.appstore(None, False)
            finally:
                os.chdir(cwd)
        self.assertEqual(stop.exception.code, 1)
        self.assertIn("Out of time", out.getvalue())
        self.assertIn("Waiting for Apple to process 1 screenshot set", out.getvalue())  # the set sent is still waited for
        self.assertEqual(list(store.sets), [IPHONE])
        self.assertEqual(store.uploaded, [b"iphone 1"])

    def test_running_out_of_time_says_so_before_a_wait_that_runs_out_too(self):
        store = FakeStore([("v1", "1.0.1", "PREPARE_FOR_SUBMISSION")], {"en-US": {"description": "Old"}, "de-DE": {"description": "Alt"}})
        with tempfile.TemporaryDirectory() as root, store:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                for locale in ("en-US", "de-DE"):
                    os.makedirs(f"appstore/screenshots/{locale}")
                    with open(f"appstore/screenshots/{locale}/1.jpg", "wb") as f: f.write(locale.encode())
                os.makedirs("appstore/de-DE")
                with open("appstore/listing.md", "w") as f: f.write("## Name\nTodorant\n## Description\nOld\n")
                with open("appstore/de-DE/listing.md", "w") as f: f.write("## Name\nTodorant\n## Description\nAlt\n")
                real_wait = listings.wait_for_processing
                def wait(a, processing):
                    for s in store.sets[IPHONE]:  # Apple is still processing the set sent
                        s["attributes"]["assetDeliveryState"]["state"] = "UPLOAD_COMPLETE"
                    real_wait(a, processing)
                clock = [0]
                def sleep(seconds): clock[0] += seconds
                # time for the first locale's set only, then the wait for it runs out of time too
                with mock.patch.object(listings, "time_for", side_effect=[True, False]), mock.patch.object(listings, "wait_for_processing", wait), \
                        mock.patch.object(listings.time, "time", lambda: clock[0]), mock.patch.object(listings.time, "sleep", sleep), \
                        contextlib.redirect_stdout(io.StringIO()) as out, self.assertRaises(SystemExit) as stop:
                    listings.appstore(None, False)
            finally:
                os.chdir(cwd)
        self.assertEqual(len(store.uploaded), 1)  # one locale's set went, the other's was left out
        self.assertIn("weren't processed in time", str(stop.exception))
        log = out.getvalue()
        self.assertIn("Out of time: this set and the ones after it", log)
        self.assertLess(log.index("Out of time"), log.index("Waiting for Apple to process 1 screenshot set"))

    def test_play_images_retried_after_a_5xx_are_not_left_in_twice(self):
        fake = FakePlay()
        with tempfile.TemporaryDirectory() as root:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                os.makedirs("fastlane/metadata/android/de-DE/images/phoneScreenshots")
                with open("fastlane/metadata/android/de-DE/title.txt", "w") as f: f.write("Quilcast")
                for n in (1, 2):
                    with open(f"fastlane/metadata/android/de-DE/images/phoneScreenshots/{n}.jpg", "wb") as f: f.write(b"jpeg %d" % n)
                with mock.patch.dict(os.environ, {"PLAY_PACKAGE": "com.example"}), \
                        mock.patch.object(listings.urllib.request, "urlopen", fake.urlopen), mock.patch.object(listings.time, "sleep"), \
                        mock.patch("play.access_token", return_value="t"):
                    listings.play(False)
            finally:
                os.chdir(cwd)
        self.assertEqual(fake.images["phoneScreenshots"], [hashlib.sha256(b"jpeg %d" % n).hexdigest() for n in (1, 2)])
        self.assertIn(("POST", "/e:commit"), fake.calls)
        # Play's default would withdraw a release in review and resubmit it
        self.assertTrue(any(u.endswith(":commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW") for u in fake.urls))

    def test_play_listing_update_keeps_the_promo_video(self):
        fake = FakePlay([{"language": "de-DE", "title": "Alt", "video": "https://youtu.be/x"}])
        with tempfile.TemporaryDirectory() as root:
            cwd = os.getcwd()
            try:
                os.chdir(root)
                os.makedirs("fastlane/metadata/android/de-DE")
                with open("fastlane/metadata/android/de-DE/title.txt", "w") as f: f.write("Quilcast")
                with mock.patch.dict(os.environ, {"PLAY_PACKAGE": "com.example"}), \
                        mock.patch.object(listings.urllib.request, "urlopen", fake.urlopen), mock.patch("play.access_token", return_value="t"):
                    listings.play(False)
            finally:
                os.chdir(cwd)
        self.assertEqual(fake.bodies, [{"language": "de-DE", "title": "Quilcast", "video": "https://youtu.be/x"}])

    def test_fdroid_rewrite_sets_the_gradle_flavor(self):
        # A flavored app's entry needs its flavor: with gradle: [yes] Gradle builds every flavor and fdroidserver finds no APK
        old = METADATA.replace("      - fdroid\n", "      - yes\n")
        new = fdroid.rewrite(old, "0.4.4", "8", "a" * 40, gradle="fdroid")
        self.assertEqual(new, fdroid.rewrite(METADATA, "0.4.4", "8", "a" * 40))
        self.assertIn("    subdir: app\n    gradle:\n      - fdroid\n\nAllowedAPKSigningKeys", new)
        # The same value changes nothing, and without FDROID_GRADLE the entry keeps the flavor it has
        self.assertEqual(fdroid.rewrite(new, "0.4.4", "8", "a" * 40, gradle="fdroid"), new)
        self.assertIn("    gradle:\n      - fdroid\n", fdroid.rewrite(new, "0.4.5", "9", "b" * 40))
        with self.assertRaises(SystemExit):
            fdroid.rewrite(METADATA.replace("    gradle:\n      - fdroid\n", ""), "0.4.4", "8", "a" * 40, gradle="fdroid")

    def test_fdroid_main_takes_the_gradle_flavor_from_the_env(self):
        old = METADATA.replace("      - fdroid\n", "      - yes\n")
        def urlopen(url):
            body = json.dumps({"state": "opened", "iid": 123, "web_url": "https://gitlab.com/mr"}) if "merge_requests" in url else old
            return io.BytesIO(body.encode())
        env = {"FDROID_MR": "123", "FDROID_APP_ID": "com.example", "FDROID_FORK": "backmeupplz/fdroiddata", "FDROID_BRANCH": "com.example",
               "FDROID_GRADLE": "fdroid"}
        with mock.patch.dict(os.environ, env), mock.patch("sys.argv", ["fdroid.py", "0.4.4", "8", "a" * 40, "--dry-run"]), \
                mock.patch.object(fdroid.urllib.request, "urlopen", urlopen), contextlib.redirect_stdout(io.StringIO()) as out:
            fdroid.main()
        self.assertIn("\n-      - yes\n+      - fdroid\n", out.getvalue())
        self.assertIn("Dry run: nothing pushed", out.getvalue())

    def test_fdroid_push_failure_reports_git_output_without_the_token(self):
        def urlopen(url):
            body = json.dumps({"state": "opened", "iid": 123, "web_url": "https://gitlab.com/mr"}) if "merge_requests" in url else METADATA
            return io.BytesIO(body.encode())
        def run(argv, cwd, **kw):
            self.assertTrue(kw["capture_output"])
            if "push" not in argv:
                if "sparse-checkout" in argv:
                    os.makedirs(os.path.join(cwd, "metadata"))
                return subprocess.CompletedProcess(argv, 0, "", "")
            return subprocess.CompletedProcess(argv, 1, "", "remote: HTTP Basic: Access denied for s3cret-token\nfatal: Authentication failed for 'https://gitlab.com/backmeupplz/fdroiddata.git/'\n")
        env = {"GITLAB_TOKEN": "s3cret-token", "FDROID_MR": "123", "FDROID_APP_ID": "com.example", "FDROID_FORK": "backmeupplz/fdroiddata", "FDROID_BRANCH": "com.example"}
        with mock.patch.dict(os.environ, env), mock.patch("sys.argv", ["fdroid.py", "0.4.4", "8", "a" * 40]), \
                mock.patch.object(fdroid.urllib.request, "urlopen", urlopen), mock.patch.object(fdroid.subprocess, "run", run), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as exit:
            fdroid.main()
        self.assertEqual(exit.exception.code, "git push failed with status 1: remote: HTTP Basic: Access denied for *** | fatal: Authentication failed for 'https://gitlab.com/backmeupplz/fdroiddata.git/'")


    def test_es256_signature_from_der(self):
        r, s = b"\x00" + b"\x80" * 32, b"\x01" * 31  # a padded r and a short s
        der = b"\x30" + bytes([4 + len(r) + len(s)]) + b"\x02" + bytes([len(r)]) + r + b"\x02" + bytes([len(s)]) + s
        self.assertEqual(appstore.raw_signature(der), b"\x80" * 32 + b"\x00" + b"\x01" * 31)


if __name__ == "__main__":
    unittest.main()
