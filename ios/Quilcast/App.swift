import StoreKit
import SwiftUI
import WebKit

// Quilcast is the web app at quilcast.com, so the app is a window onto it: the site keeps its keys in this web view's
// own storage, and every update reaches the app the moment it's deployed. Links to other sites open in Safari.
let home = URL(string: "https://quilcast.com/")!

func ours(_ url: URL) -> Bool {
    url.scheme == "https" && (url.host == "quilcast.com" || url.host == "www.quilcast.com")
}

/** One of our pages, as what a new window opens on or a window comes back to. */
func page(_ url: URL?) -> NSUserActivity? {
    guard let url, ours(url) else { return nil }
    let activity = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
    activity.webpageURL = url
    // a window's saved activity comes back after a relaunch without its webpageURL
    activity.userInfo = ["url": url.absoluteString]
    return activity
}

func url(_ activity: NSUserActivity) -> URL? {
    activity.webpageURL ?? (activity.userInfo?["url"] as? String).flatMap(URL.init(string:))
}

// Reports the colors of the page's header and of its background whenever they may have changed, so the status bar's
// text stays readable on dark themes and profile looks and the strips beside the page match it. Android's
// MainActivity.java has an older copy that reports the header's color alone.
let bar = """
(() => { let last, queued; const color = (...els) => { for (const el of els) { if (!el) continue;
    const c = getComputedStyle(el).backgroundColor, n = c.match(/[\\d.]+/g)?.map(Number); if (!n || n[3] === 0) continue;
    return '#' + n.slice(0, 3).map((v) => Math.round(c.startsWith('color(') ? v * 255 : v).toString(16).padStart(2, '0')).join('') } };
  // the header's color for the status bar, the page's for the strips beside it
  const probe = () => { queued = false; const page = color(document.body, document.documentElement); if (!page) return;
    const both = (color(document.querySelector('.phead')) ?? page) + ' ' + page; if (both !== last) webkit.messageHandlers.bar.postMessage(last = both) };
  const later = () => queued || (queued = true, setTimeout(probe, 200));
  new MutationObserver(later).observe(document, { attributes: true, childList: true, subtree: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', later); later() })()
"""

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    // The menu bar, and the shortcuts a held ⌘ lists, with a keyboard on an iPad (or an iPhone). They act on the window
    // in front (Web.command, then the page's own app.tsx quilcastCommand).
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard builder.system == .main else { return }
        let page = { (title: String, input: String, to: String) in
            UIKeyCommand(title: title, action: #selector(Web.command(_:)), input: input, modifierFlags: .command, propertyList: to)
        }
        var new = [page(String(localized: "New Cast"), "n", "compose")]
        if UIApplication.shared.supportsMultipleScenes {
            new.append(UIKeyCommand(title: String(localized: "New Window"), action: #selector(Web.newWindow(_:)), input: "n", modifierFlags: [.command, .alternate]))
        }
        builder.insertChild(UIMenu(options: .displayInline, children: new), atStartOfMenu: .file)
        // Quilcast's own settings, rather than its page in the Settings app
        builder.replaceChildren(ofMenu: .preferences) { _ in [page(String(localized: "Settings…"), ",", "settings")] }
        // ⌘F searches Farcaster, not the page (a menu with a shortcut another one has isn't added at all)
        builder.remove(menu: .find)
        builder.insertSibling(UIMenu(title: String(localized: "Go"), identifier: UIMenu.Identifier("com.borodutch.quilcast.go"), children: [
            UIMenu(options: .displayInline, children: [
                UIKeyCommand(title: String(localized: "Back"), action: #selector(Web.back(_:)), input: "[", modifierFlags: .command),
                UIKeyCommand(title: String(localized: "Forward"), action: #selector(Web.forward(_:)), input: "]", modifierFlags: .command),
            ]),
            UIMenu(options: .displayInline, children: [
                page(String(localized: "Home"), "1", "home"), page(String(localized: "Notifications"), "2", "notifications"),
                page(String(localized: "Messages"), "3", "messages"), page(String(localized: "Profile"), "4", "profile"),
                page(String(localized: "Search"), "f", "search"),
            ]),
        ]), afterMenu: .view)
        // the page has no toolbar to customize or sidebar to hide
        builder.remove(menu: .toolbar)
        builder.remove(menu: .sidebar)

    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    let web = Web()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: scene)
        window?.rootViewController = web
        window?.makeKeyAndVisible()
        // a link, a window opened on a page (Open in New Window), or a window coming back with the page it last showed
        let link = options.userActivities.first.flatMap(url) ?? options.urlContexts.first?.url ?? session.stateRestorationActivity.flatMap(url)
        web.open(link.flatMap { ours($0) ? $0 : nil } ?? home)
    }

    // each window (an iPad can have several) reopens on its own page
    func stateRestorationActivity(for scene: UIScene) -> NSUserActivity? {
        page(web.web?.url)
    }

    // quilcast.com links (universal links)
    func scene(_ scene: UIScene, continue activity: NSUserActivity) {
        if let url = activity.webpageURL, ours(url) { web.open(url) }
    }

    // a closed window's page stops: the script handlers hold the page's controller, which holds the web view
    func sceneDidDisconnect(_ scene: UIScene) {
        web.web?.configuration.userContentController.removeAllScriptMessageHandlers()
    }

    // back from the background (a link opened in Safari), not from Control Center or a system alert over the app
    var wasAway = false
    func sceneDidEnterBackground(_ scene: UIScene) {
        wasAway = true
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        RatingPrompt.used()
        if wasAway { web.settle() }
        wasAway = false
    }
}

class Web: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var web: WKWebView!
    // the header's and the page's colors, from the page
    var colors: (head: Int, page: Int)?
    // the status bar's text sits on the header, or in the strip beside the page where there is one (an iPhone Duo's
    // cover display has its status pill there), and the strip has the page's color
    var dark: Bool {
        guard let colors else { return false }
        let rgb = view.safeAreaInsets.left + view.safeAreaInsets.right > 0 ? colors.page : colors.head
        return 0.2126 * Double(rgb >> 16) + 0.7152 * Double(rgb >> 8 & 0xff) + 0.0722 * Double(rgb & 0xff) < 128
    }
    // no rating prompt after the page crashed this session
    var crashed = false

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // Spaces and the profile song start from a tap the page already saw
        config.mediaTypesRequiringUserActionForPlayback = []
        // An iPad's web view would pick a Mac's user agent and desktop pages for a wide window and an iPad's for a narrow
        // one, changing as the window is resized; the page lays itself out by its width anyway (style.css)
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        config.applicationNameForUserAgent = "Mobile/15E148 QuilcastApp/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "") (iOS)"
        config.userContentController.addUserScript(WKUserScript(source: bar, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        config.userContentController.add(self, name: "bar")
        config.userContentController.add(self, name: "requestReview")
        #if DEBUG
        // LOCAL ONLY (App Review demo recording, board #308): QC_DEMO_JS = a script file path (simulator) or the script
        if let v = ProcessInfo.processInfo.environment["QC_DEMO_JS"], let js = v.hasPrefix("/") ? try? String(contentsOfFile: v, encoding: .utf8) : v {
            config.userContentController.addUserScript(WKUserScript(source: "window.__qcAgreed = \(UserDefaults.standard.bool(forKey: "agreed"));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
            config.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            config.userContentController.add(self, name: "demo")
        }
        #endif
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        // the page pads itself with env(safe-area-inset-*) (viewport-fit=cover) and draws under the status bar
        web.scrollView.contentInsetAdjustmentBehavior = .never
        // The page spans the window's height but only its safe width, and the strips beside it take the page's color.
        // Phones in portrait have no side insets, so there it fills the window; an iPhone Duo's cover display has a
        // strip down its right edge with the camera and the status bar's pill in it, which would cover the page's
        // buttons. Folding or unfolding the phone (or resizing the window) only resizes this one web view, which lasts
        // as long as the scene, so the page keeps its scroll, what's being typed, open sheets and what's playing; the
        // page lays itself out by its width (style.css). Nothing here reads the screen's size.
        let root = UIView()
        root.backgroundColor = .systemBackground
        web.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: root.topAnchor),
            web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            web.leftAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leftAnchor),
            web.rightAnchor.constraint(equalTo: root.safeAreaLayoutGuide.rightAnchor),
        ])
        view = root
    }

    // the menu bar's commands look for a responder from the one that has the focus up; before anything in the page
    // has it (a fresh window, or once the community rules close), that's this one. Only then: coming back from the
    // camera or a file picker, the page keeps the focus it had
    override var canBecomeFirstResponder: Bool { true }
    var appeared = false

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !appeared { appeared = true; becomeFirstResponder() }
        // App Review 1.2: people agree to the community rules before they see anything others posted
        guard !UserDefaults.standard.bool(forKey: "agreed"), presentedViewController == nil else { return }
        let agree = { [weak self] in
            UserDefaults.standard.set(true, forKey: "agreed")
            self?.dismiss(animated: true) { self?.becomeFirstResponder() }
            #if DEBUG
            self?.web.evaluateJavaScript("window.__qcAgreed = true")
            #endif
        }
        let rules = UIHostingController(rootView: Rules(agree: agree))
        rules.isModalInPresentation = true
        present(rules, animated: true)
        #if DEBUG
        // LOCAL ONLY demo recording: read the rules for a moment, then agree
        if ProcessInfo.processInfo.environment["QC_DEMO_JS"] != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 7, execute: agree) }
        #endif
    }

    func open(_ url: URL) {
        loadViewIfNeeded()
        web.load(URLRequest(url: url))
    }

    /** Gives WebKit the web view's size again as the app comes back from the background. After a link opened in Safari,
     *  the bars that stay put on the screen (the tab bar, the compose button, the mini app dock) have been seen partway
     *  up it, scrolling with the page, as if WebKit laid the page out for another size (#666; not reproduced). The web
     *  view only sends its size when that changes, so it's made a point shorter and given its size back at once, before
     *  anything is drawn; shorter first, so a page scrolled to its end keeps its place. */
    func settle() {
        view.layoutIfNeeded()
        guard let web, web.window != nil, web.bounds.height > 1 else { return }
        let frame = web.frame
        web.frame = CGRect(origin: frame.origin, size: CGSize(width: frame.width, height: frame.height - 1))
        web.frame = frame
    }

    // the menu bar's commands (AppDelegate.buildMenu), while nothing is over the page
    @objc func command(_ sender: UICommand) {
        guard let to = sender.propertyList as? String else { return }
        web.evaluateJavaScript("window.quilcastCommand?.('\(to)')")
    }

    // ⌘[ and ⌘]: through the page too, which keeps a cast being written where it is
    @objc func back(_ sender: Any?) { web.evaluateJavaScript("window.quilcastCommand ? quilcastCommand('back') : history.back()") }

    @objc func forward(_ sender: Any?) { web.evaluateJavaScript("window.quilcastCommand ? quilcastCommand('forward') : history.forward()") }

    @objc func newWindow(_ sender: Any?) { openWindow(nil) }

    func openWindow(_ url: URL?) {
        let request = UISceneSessionActivationRequest(role: .windowApplication, userActivity: page(url))
        UIApplication.shared.activateSceneSession(for: request)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        switch action {
        case #selector(command(_:)), #selector(newWindow(_:)): presentedViewController == nil
        case #selector(back(_:)): presentedViewController == nil && web.canGoBack
        case #selector(forward(_:)): presentedViewController == nil && web.canGoForward
        default: super.canPerformAction(action, withSender: sender)
        }
    }

    // On an iPad, our links' menus (a long press, or a right click) open them in a window of their own too; anything
    // else gets the web view's own menu
    func webView(_ web: WKWebView, contextMenuConfigurationFor element: WKContextMenuElementInfo) async -> UIContextMenuConfiguration? {
        guard UIApplication.shared.supportsMultipleScenes, let url = element.linkURL, ours(url) else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] suggested in
            UIMenu(children: [UIAction(title: String(localized: "Open in New Window"), image: UIImage(systemName: "macwindow.badge.plus")) { _ in self?.openWindow(url) }] + suggested)
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { dark ? .lightContent : .darkContent }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        setNeedsStatusBarAppearanceUpdate()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        if message.name == "demo" { print("QCDEMO", message.body); fflush(stdout); return }
        // the page reports each cast or reply sent; RatingPrompt decides whether that's the moment to ask for a rating
        if message.name == "requestReview" {
            if !crashed, RatingPrompt.cast(), let scene = view.window?.windowScene { AppStore.requestReview(in: scene) }
            return
        }
        // "#header #page"
        let rgbs = (message.body as? String)?.split(separator: " ").compactMap { hex in hex.count == 7 ? Int(hex.dropFirst(), radix: 16) : nil }
        guard let rgbs, rgbs.count == 2 else { return }
        let page = rgbs[1]
        colors = (rgbs[0], page)
        view.backgroundColor = UIColor(red: CGFloat(page >> 16) / 255, green: CGFloat(page >> 8 & 0xff) / 255, blue: CGFloat(page & 0xff) / 255, alpha: 1)
        setNeedsStatusBarAppearanceUpdate()
    }

    func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        // mini apps navigate inside their own frames
        if action.targetFrame?.isMainFrame == false || ours(url) || url.scheme == "about" || url.scheme == "blob" { return .allow }
        await UIApplication.shared.open(url)
        return .cancel
    }

    // target=_blank and window.open: our pages load here, everything else opens in Safari
    func webView(_ web: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if ours(url) { web.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    // a crashed web content process leaves a blank page; load it again
    func webViewWebContentProcessDidTerminate(_ web: WKWebView) {
        crashed = true
        web.reload()
    }
}

struct Rules: View {
    let agree: () -> Void
    var body: some View {
        // the text scrolls when it's too long for the screen (the largest text sizes); the button stays at the bottom
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Welcome to Quilcast").font(.largeTitle.bold())
                    Text("Quilcast shows posts from Farcaster, an open social network. By continuing you agree to the Terms of Use: no objectionable content, no harassment, no spam, and nothing illegal. There's zero tolerance for abusive users or content.")
                    Text("Mute or block anyone from the ⋯ menu on their casts or profile, and report a cast or a person from the same menu. We look at every report within 24 hours.")
                    Link("Read the Terms of Use", destination: URL(string: "https://quilcast.com/terms")!)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
            .scrollBounceBehavior(.basedOnSize)
            Button(action: agree) { Text("I agree").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .padding([.horizontal, .bottom], 24)
        }
        // a readable column on wide screens, such as an unfolded iPhone Duo
        .frame(maxWidth: 600)
        .frame(maxWidth: .infinity)
        .tint(Color(red: 0.357, green: 0.239, blue: 0.961))
    }
}
