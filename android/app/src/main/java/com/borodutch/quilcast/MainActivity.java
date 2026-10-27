package com.borodutch.quilcast;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.util.ArrayList;
import java.util.List;

/**
 * Quilcast is the web app at quilcast.com, so the app is a window onto it: the site keeps its keys in this WebView's
 * own storage, and every update reaches the app the moment it's deployed. Links to other sites open in the browser.
 */
public class MainActivity extends Activity {
    static final String HOME = "https://quilcast.com/";
    static final int FILES = 1, MEDIA = 2;
    // Reports the color of the page's header (or its background) whenever it may have changed: the status and
    // navigation bars take it, so a dark theme or profile look doesn't sit under a light strip. Same script in iOS's App.swift.
    static final String BAR = "(() => { let last, queued; const probe = () => { queued = false;"
        + " for (const el of [document.querySelector('.phead'), document.body, document.documentElement]) { if (!el) continue;"
        + " const c = getComputedStyle(el).backgroundColor, n = c.match(/[\\d.]+/g)?.map(Number); if (!n || n[3] === 0) continue;"
        + " const hex = '#' + n.slice(0, 3).map((v) => Math.round(c.startsWith('color(') ? v * 255 : v).toString(16).padStart(2, '0')).join('');"
        + " if (hex !== last) QuilcastBar.color(last = hex); return } };"
        + " const later = () => queued || (queued = true, setTimeout(probe, 200));"
        + " new MutationObserver(later).observe(document, { attributes: true, childList: true, subtree: true }); later() })()";

    WebView web;
    FrameLayout root;
    ValueCallback<Uri[]> pickFiles;
    PermissionRequest askMedia;
    View fullscreen;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web);
        setContentView(root);
        bars(getColor(R.color.paper)); // until the page reports its own
        // edge to edge (Android 15 does it anyway): keep the page clear of the status bar, the navigation bar and the keyboard
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Spaces and the profile song start from a tap the page already saw
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " QuilcastApp/" + BuildConfig.VERSION_NAME + " (Android)");
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true); // mini apps sign in inside their frames
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void color(String hex) {
                if (hex.matches("#[0-9a-f]{6}")) runOnUiThread(() -> bars(Color.parseColor(hex)));
            }
        }, "QuilcastBar");
        // the page reports each cast or reply sent; RatingPrompt decides whether that's the moment to ask for a rating
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void requestReview() {
                runOnUiThread(() -> RatingPrompt.cast(MainActivity.this));
            }
        }, "QuilcastApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (ours(Uri.parse(url))) view.evaluateJavascript(BAR, null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // mini apps navigate inside their own frames
                if (!request.isForMainFrame() || ours(request.getUrl())) return false;
                open(request.getUrl());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pickFiles != null) pickFiles.onReceiveValue(null);
                pickFiles = callback;
                try {
                    startActivityForResult(params.createIntent(), FILES);
                } catch (ActivityNotFoundException e) {
                    pickFiles = null;
                    return false;
                }
                return true;
            }

            // the page asks first (per mini app, or when going on stage in a Space); then Android asks once for the app
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                List<String> need = new ArrayList<>();
                for (String r : request.getResources()) {
                    if (r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) need.add(Manifest.permission.RECORD_AUDIO);
                    if (r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) need.add(Manifest.permission.CAMERA);
                }
                need.removeIf(p -> checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED);
                if (need.isEmpty()) {
                    request.grant(request.getResources());
                    return;
                }
                if (askMedia != null) askMedia.deny();
                askMedia = request;
                requestPermissions(need.toArray(new String[0]), MEDIA);
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                fullscreen = view;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }

            @Override
            public void onHideCustomView() {
                root.removeView(fullscreen);
                fullscreen = null;
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(start(getIntent()));
    }

    // the bars show through the padding around the page; dark icons on a light color, light ones on a dark color
    void bars(int color) {
        root.setBackgroundColor(color);
        boolean light = Color.luminance(color) > 0.5;
        int both = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        getWindow().getInsetsController().setSystemBarsAppearance(light ? both : 0, both);
    }

    static boolean ours(Uri u) {
        return "https".equals(u.getScheme()) && ("quilcast.com".equals(u.getHost()) || "www.quilcast.com".equals(u.getHost()));
    }

    static String start(Intent intent) {
        Uri u = intent.getData();
        return u != null && ours(u) ? u.toString() : HOME;
    }

    void open(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    // Back walks the page's history (the manifest opts out of predictive back so this still runs on Android 16)
    @Override
    public void onBackPressed() {
        if (fullscreen != null) web.getWebChromeClient().onHideCustomView();
        else if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        RatingPrompt.used(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) web.loadUrl(start(intent));
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != FILES || pickFiles == null) return;
        pickFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        pickFiles = null;
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        if (request != MEDIA || askMedia == null) return;
        for (int r : results) if (r != PackageManager.PERMISSION_GRANTED) {
            askMedia.deny();
            askMedia = null;
            return;
        }
        askMedia.grant(askMedia.getResources());
        askMedia = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        web.saveState(state);
    }
}
