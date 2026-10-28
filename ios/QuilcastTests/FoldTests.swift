import SwiftUI
import UIKit
import WebKit
import XCTest
@testable import Quilcast

/*
 Folding an iPhone Duo (or resizing the app's window) changes its width and size class while it runs. Quilcast's state
 lives in the page (where you've scrolled to, a cast being written, an open sheet, a Space or a song playing), so it only
 survives if the web view is neither replaced nor reloaded; and the page has to use the unfolded width rather than
 stretch a phone's column. These flip one window between a phone's width and an unfolded one's, and check both.

 QUILCAST_SCREENSHOTS (passed as TEST_RUNNER_QUILCAST_SCREENSHOTS to xcodebuild) names a directory for snapshots of each
 state, on whichever simulator runs the tests; QUILCAST_SCREENSHOTS_URL adds snapshots of that page (quilcast.com by
 default) folded and unfolded.
 */
@MainActor
final class FoldTests: XCTestCase {
    static let phone = CGSize(width: 390, height: 844), unfolded = CGSize(width: 669, height: 951) // a Duo's inner display
    static let site = URL(string: "https://quilcast.com/")!

    var window: UIWindow!, page: Web!

    override func setUp() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        window = try XCTUnwrap(scene.windows.first { $0.rootViewController is Web })
        page = window.rootViewController as? Web
        // the app's first page, and the community rules sliding up over it on a first launch
        try await until("the first page has shown") { self.page.viewIfLoaded?.window != nil && self.page.transitionCoordinator == nil }
        _ = try await wait { !self.page.web.isLoading }
        try await Task.sleep(for: .seconds(1))
    }

    override func tearDown() async throws {
        page?.additionalSafeAreaInsets = .zero
        window?.traitOverrides.remove(UITraitHorizontalSizeClass.self)
        window?.frame = window.windowScene!.coordinateSpace.bounds
    }

    func testFoldingKeepsThePageAsItWas() async throws {
        let web = page.web!
        try await load("""
            <dialog id="sheet" style="position: fixed; top: 60px"><textarea id="draft" style="font-size: 18px"></textarea></dialog>
            \(String(repeating: "<div style='height: 400px; border-bottom: 1px solid'></div>", count: 12))
            <script>let ticks = 0; setInterval(() => ticks++, 20)</script>
            """)
        try await fold(.compact)
        // a cast half written in the composer (its text is 18px, so iOS doesn't zoom in on it), a sheet open over the
        // feed, the feed scrolled down and something running
        try await js("""
            window.folded = 'still here'
            scrollTo(0, 1600); document.getElementById('sheet').show()
            const draft = document.getElementById('draft'); draft.value = 'gm from the cover display'; draft.focus()
            """)
        if page.presentedViewController == nil { present(rules()) }
        let sheet = page.presentedViewController
        snapshot("state-compact")
        // where the feed is once the keyboard is up: on a simulator without a hardware keyboard, WebKit scrolls the
        // focused draft into view as the software one slides in
        try await Task.sleep(for: .seconds(1))
        let place = try await js("return scrollY")
        XCTAssertNotEqual(place, "0", "the feed is scrolled down")

        for size in [UIUserInterfaceSizeClass.regular, .compact, .regular] {
            let ticks = Int(try await js("return ticks")) ?? 0
            try await fold(size)
            XCTAssert(page.web === web, "the web view was replaced")
            XCTAssert(page.presentedViewController === sheet, "the community rules closed")
            let folded = try await js("return folded"), draft = try await js("return document.getElementById('draft').value")
            let focused = try await js("return document.activeElement.id"), open = try await js("return String(document.getElementById('sheet').open)")
            let scrolled = try await js("return scrollY"), scale = try await js("return visualViewport.scale")
            XCTAssertEqual(folded, "still here", "the page reloaded")
            XCTAssertEqual(draft, "gm from the cover display", "the cast being written was lost")
            XCTAssertEqual(focused, "draft", "the cast being written lost its cursor")
            XCTAssertEqual(open, "true", "the sheet closed")
            XCTAssertEqual(scrolled, place, "the page lost its place")
            XCTAssertEqual(scale, "1", "the page is zoomed")
            try await until("the page keeps running") { (Int((try? await self.js("return ticks")) ?? "") ?? 0) > ticks }
        }
        snapshot("state-regular")
        page.dismiss(animated: false)
    }

    func testThePageUsesAnUnfoldedWidthAndMirrorsRightToLeft() async throws {
        // The app's frame (app.tsx) with this checkout's styles, as the site will serve them
        let styles = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../src/style.css")
        guard let css = try? String(contentsOf: styles, encoding: .utf8) else { throw XCTSkip("Needs the repository's src/style.css") }
        try await load("""
            <style>\(css)</style>
            <div class="app">
              <nav class="side"><a class="brand"><span>Quilcast</span></a></nav>
              <main class="col"><div style="height: 2000px"></div><div class="dm-compose"><button class="btn" id="send">Send</button></div></main>
              <aside class="extra"></aside>
              <nav class="tabbar"><a>1</a><a>2</a><a>3</a></nav>
              <div class="dock"><button>1</button></div>
            </div>
            """)
        let place = "return JSON.stringify(['.side', '.col', '.extra', '.tabbar'].map((s) => document.querySelector(s).getBoundingClientRect()).map((r) => [r.left, r.right, r.width]))"
        func boxes() async throws -> [[Double]] { try JSONDecoder().decode([[Double]].self, from: Data(try await js(place).utf8)) }
        // the message box's button and the mini app dock stay above the home indicator, in either layout
        func clearOfTheHomeIndicator(_ what: String) async throws {
            let edge = Double(page.web.bounds.height - page.web.safeAreaInsets.bottom)
            for s in ["#send", ".dock"] {
                let bottom = Double(try await js("return document.querySelector('\(s)').getBoundingClientRect().bottom")) ?? .infinity
                XCTAssertLessThanOrEqual(bottom, edge, "\(what): \(s) is clear of the home indicator")
            }
        }

        try await fold(.compact)
        snapshot("layout-compact")
        var r = try await boxes(), width = page.web.bounds.width
        XCTAssertEqual(r[0][2], 0, "a phone has no sidebar")
        XCTAssertEqual(r[3][2], width, "a phone has the tab bar")
        XCTAssertEqual(r[1][0], 0); XCTAssertEqual(r[1][2], width, "a phone's column is the screen's width")
        try await clearOfTheHomeIndicator("a phone")
        let padding = try await js("return getComputedStyle(document.querySelector('.dm-compose')).paddingBottom")
        XCTAssertEqual(padding, "10px", "on a phone the message box sits on the tab bar, which already clears the home indicator")

        try await fold(.regular)
        snapshot("layout-regular")
        r = try await boxes(); width = page.web.bounds.width
        XCTAssertEqual(r[3][2], 0, "unfolded, the tab bar gives way to the sidebar")
        XCTAssertEqual(r[0][0], 0); XCTAssertEqual(r[0][2], 76, "unfolded, the sidebar's rail is at the left")
        XCTAssertEqual(r[1][0], 76, "the column is beside the rail")
        XCTAssertEqual(r[1][1], width)
        XCTAssertLessThanOrEqual(r[1][2], 600, "the column keeps a readable width")
        XCTAssertEqual(r[2][2], 0, "no room for the right column")
        let brand = Double(try await js("return document.querySelector('.side .brand').getBoundingClientRect().top")) ?? -1
        XCTAssertGreaterThanOrEqual(brand, page.web.safeAreaInsets.top, "the sidebar starts below the status bar")
        try await clearOfTheHomeIndicator("unfolded")

        try await js("document.documentElement.dir = 'rtl'")
        snapshot("layout-regular-rtl")
        r = try await boxes()
        XCTAssertEqual(r[0][1], width, "right to left, the rail is at the right")
        XCTAssertEqual(r[1][1], width - 76)
        try await js("document.documentElement.dir = ''")
    }

    func testThePageKeepsClearOfTheSidesAndFillsUnderTheBars() async throws {
        try await load("<style>body { background: #123456 } .phead { background: #fedcba } #top { padding-top: env(safe-area-inset-top) }</style><div class='phead' id='top'></div>")
        try await fold(.compact)
        // what an iPhone Duo's cover display reports: a strip down its right edge with the camera and the status pill
        page.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 84)
        page.view.layoutIfNeeded()
        let view = page.view!, frame = page.web.frame
        XCTAssertEqual(frame.minX, view.safeAreaInsets.left)
        XCTAssertEqual(frame.maxX, view.bounds.width - view.safeAreaInsets.right, "the page is clear of the strip")
        XCTAssertEqual(frame.minY, 0, "the page draws under the status bar")
        XCTAssertEqual(frame.maxY, view.bounds.height, "the page draws under the home indicator")
        let top = Double(try await js("return document.getElementById('top').getBoundingClientRect().height")) ?? -1
        XCTAssertEqual(top, page.web.safeAreaInsets.top, accuracy: 1, "the page knows how much the status bar takes")
        try await until("the strip has the page's color") { self.page.view.backgroundColor == UIColor(red: 0x12 / 255, green: 0x34 / 255, blue: 0x56 / 255, alpha: 1) }
        XCTAssertEqual(page.preferredStatusBarStyle, .lightContent, "the status pill is in the strip, which is dark here")
        snapshot("strip")
        page.additionalSafeAreaInsets = .zero
        page.view.layoutIfNeeded()
        // (an iPhone Duo's cover display has a strip of its own)
        if view.safeAreaInsets.left + view.safeAreaInsets.right == 0 {
            XCTAssertEqual(page.preferredStatusBarStyle, .darkContent, "without a strip the status bar is on the header, which is light here")
        }
    }

    func testWhatCoversTheScreenLeavesThePageAlone() async throws {
        // on a simulator whose screen something covers (an iPhone Duo's cover display, from iOS 27.1), as the app runs
        guard #available(iOS 27.1, *) else { throw XCTSkip("Reserved regions are iOS 27.1's") }
        page.view.layoutIfNeeded()
        let covered = page.view.reservedRegions(kind: .occlusion).map(\.frame)
        guard !covered.isEmpty else { throw XCTSkip("Nothing covers this simulator's screen") }
        let web = page.web.convert(page.web.bounds, to: page.view)
        XCTAssertGreaterThan(web.width, 0)
        for r in covered { XCTAssertFalse(r.intersects(web), "\(r) covers the page at \(web)") }
        snapshot("covered")
    }

    func testTheRulesFitEveryScreenAndTextSize() async throws {
        let sizes: [(CGSize, UIUserInterfaceSizeClass)] = [(Self.phone, .compact), (Self.unfolded, .regular)]
        for (size, width) in sizes {
            for text in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
                let rules = UIHostingController(rootView: Rules {}), sheet = UIWindow(windowScene: window.windowScene!)
                sheet.frame = CGRect(origin: .zero, size: size)
                sheet.traitOverrides.horizontalSizeClass = width
                sheet.traitOverrides.preferredContentSizeCategory = text
                sheet.rootViewController = rules
                sheet.isHidden = false
                defer { sheet.isHidden = true }
                try await Task.sleep(for: .milliseconds(500))
                sheet.layoutIfNeeded()
                let scroll = try XCTUnwrap(first(UIScrollView.self, in: rules.view), "the text is in a scroll view")
                let frame = scroll.convert(scroll.bounds, to: rules.view), bottom = rules.view.bounds.height - rules.view.safeAreaInsets.bottom
                let what = "\(width == .regular ? "unfolded" : "a phone"), \(text.rawValue)"
                XCTAssertGreaterThan(frame.height, bottom / 2, "\(what): the text has the screen, but for the button")
                XCTAssertLessThan(bottom - frame.maxY, 120, "\(what): the button is at the bottom")
                // (from iOS 27.1 the scroll view itself reaches the window's edges, so this measures what's in it)
                let column = CGRect(x: frame.minX + scroll.adjustedContentInset.left, y: frame.minY, width: scroll.contentSize.width, height: frame.height)
                XCTAssertLessThanOrEqual(column.width, 600, "\(what): a readable column")
                XCTAssertEqual(column.midX, rules.view.bounds.inset(by: rules.view.safeAreaInsets).midX, accuracy: 1, "\(what): in the middle")
                if text.isAccessibilityCategory { XCTAssertGreaterThan(scroll.contentSize.height, frame.height, "\(what): the text scrolls") }
                snapshot("rules-\(width == .regular ? "regular" : "compact")", of: sheet)
            }
        }
    }

    /** Snapshots of the site itself, folded and unfolded, when asked for (see the top). */
    func testScreenshotsOfTheSite() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["QUILCAST_SCREENSHOTS"] != nil else { throw XCTSkip("QUILCAST_SCREENSHOTS is not set") }
        page.open(env["QUILCAST_SCREENSHOTS_URL"].flatMap(URL.init(string:)) ?? Self.site)
        for size in [UIUserInterfaceSizeClass.compact, .regular] {
            try await fold(size)
            try await Task.sleep(for: .seconds(5)) // its feed and images
            snapshot("site-\(size == .regular ? "regular" : "compact")")
        }
    }

    /** Resizes the window to a phone's, or an unfolded Duo's, with that size class; and waits until the page has the new width. */
    func fold(_ size: UIUserInterfaceSizeClass) async throws {
        window.traitOverrides.horizontalSizeClass = size
        window.frame = CGRect(origin: .zero, size: size == .regular ? Self.unfolded : Self.phone)
        window.layoutIfNeeded()
        XCTAssertEqual(page.traitCollection.horizontalSizeClass, size)
        // the system can move the safe area (an iPhone Duo's strip) a moment after the window changes, so the web view's
        // width is only settled once it and the page have agreed for a few checks in a row
        var width = "", seen = "", agreed = 0
        try await until("the page is \(width) wide, not \(seen)") {
            let now = String(Int(self.page.web.bounds.width))
            let inPage = (try? await self.js("return [innerWidth, document.documentElement.clientWidth, visualViewport.width, visualViewport.scale].join(' ')")) ?? "?"
            agreed = inPage.hasPrefix(now + " ") && (now, inPage) == (width, seen) ? agreed + 1 : 0
            (width, seen) = (now, inPage)
            return agreed >= 3
        }
    }

    /** Shows `body` as a quilcast.com page, so the app treats it as its own. */
    func load(_ body: String) async throws {
        let id = UUID().uuidString
        let html = "<!doctype html><meta name='viewport' content='width=device-width, initial-scale=1, viewport-fit=cover'><body data-test='\(id)'>\(body)</body>"
        // quilcast.com, which the app opened as it started, may still navigate on its own: ask again
        for _ in 0..<3 {
            page.web.loadHTMLString(html, baseURL: Self.site)
            if try await wait(seconds: 5, { (try? await self.js("return document.body?.dataset.test")) == id }) { return }
        }
        XCTFail("the page didn't load")
        throw CancellationError()
    }

    /** Runs `body` as a function's in the page; what it returns, as text. */
    @discardableResult
    func js(_ body: String) async throws -> String {
        let result = try await page.web.callAsyncJavaScript(body, contentWorld: .page)
        return result.map { "\($0)" } ?? ""
    }

    func until(_ what: @autoclosure () -> String, _ check: () async -> Bool) async throws {
        if try await wait(check) { return }
        XCTFail("timed out waiting until \(what())")
        throw CancellationError()
    }

    /** Whether `check` came true within `seconds`. */
    func wait(seconds: Double = 15, _ check: () async -> Bool) async throws -> Bool {
        for _ in 0..<Int(seconds * 10) {
            if await check() { return true }
            try await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    func first<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        view as? View ?? view.subviews.lazy.compactMap { self.first(type, in: $0) }.first
    }

    func rules() -> UIViewController { let v = UIHostingController(rootView: Rules {}); v.isModalInPresentation = true; return v }

    func present(_ controller: UIViewController) { page.present(controller, animated: false) }

    func snapshot(_ name: String, of window: UIWindow? = nil) {
        guard let dir = ProcessInfo.processInfo.environment["QUILCAST_SCREENSHOTS"], let window = window ?? self.window else { return }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let traits = window.traitCollection
        let variant = [traits.userInterfaceStyle == .dark ? "dark" : "light", traits.preferredContentSizeCategory.isAccessibilityCategory ? "ax" : nil,
                       traits.layoutDirection == .rightToLeft ? "rtl" : nil].compactMap { $0 }.joined(separator: "-")
        try? image.pngData()?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(variant).png"))
    }
}
