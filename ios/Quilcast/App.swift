import StoreKit
import SwiftUI
import WebKit

// Quilcast is the web app at quilcast.com, so the app is a window onto it: the site keeps its keys in this web view's
// own storage, and every update reaches the app the moment it's deployed. Links to other sites open in Safari.
let home = URL(string: "https://quilcast.com/")!

func ours(_ url: URL) -> Bool {
    url.scheme == "https" && (url.host == "quilcast.com" || url.host == "www.quilcast.com")
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
class AppDelegate: UIResponder, UIApplicationDelegate {}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    let web = Web()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: scene)
        window?.rootViewController = web
        window?.makeKeyAndVisible()
        let link = options.userActivities.first?.webpageURL ?? options.urlContexts.first?.url
        web.open(link.flatMap { ours($0) ? $0 : nil } ?? home)
    }

    // quilcast.com links (universal links)
    func scene(_ scene: UIScene, continue activity: NSUserActivity) {
        if let url = activity.webpageURL, ours(url) { web.open(url) }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        RatingPrompt.used()
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
        config.applicationNameForUserAgent = "Mobile/15E148 QuilcastApp/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "") (iOS)"
        config.userContentController.addUserScript(WKUserScript(source: bar, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        config.userContentController.add(self, name: "bar")
        config.userContentController.add(self, name: "requestReview")
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

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // App Review 1.2: people agree to the community rules before they see anything others posted
        guard !UserDefaults.standard.bool(forKey: "agreed"), presentedViewController == nil else { return }
        let rules = UIHostingController(rootView: Rules { [weak self] in
            UserDefaults.standard.set(true, forKey: "agreed")
            self?.dismiss(animated: true)
        })
        rules.isModalInPresentation = true
        present(rules, animated: true)
    }

    func open(_ url: URL) {
        loadViewIfNeeded()
        web.load(URLRequest(url: url))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { dark ? .lightContent : .darkContent }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        setNeedsStatusBarAppearanceUpdate()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
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
