import UIKit
import WebKit

/// Project icons that are SVG (a `favicon.svg`, `icon.svg`, `logo.svg`): iOS can't decode SVG as
/// an image, so the avatar fell back to its letter while the web app showed the icon. This draws
/// one into a PNG once, in a sealed web view, and the PNG is what's cached and shown.
///
/// The SVG comes from a project's files, so it's treated as untrusted: it's shown through an
/// `<img>` (SVG there can't run scripts or load anything), in a page with JavaScript off, a
/// Content-Security-Policy that allows nothing but inline data, a throwaway data store, and no
/// navigation.
@MainActor
enum SVGIcon {
    /// Points; the snapshot is at the screen's scale (about 192 px, `AppModel.avatarPixels`).
    static let side: CGFloat = 64

    /// PNG for SVG data; other data (PNG, ICO, JPEG…) back as it is.
    static func rasterizeIfNeeded(_ data: Data) async -> Data {
        guard isSVG(data) else { return data }
        return await rasterize(data) ?? data
    }

    nonisolated static func isSVG(_ data: Data) -> Bool {
        guard let head = String(data: data.prefix(1024), encoding: .utf8) else { return false }
        return head.range(of: "<svg", options: .caseInsensitive) != nil
    }

    static func rasterize(_ svg: Data) async -> Data? {
        guard svg.count < 1_000_000,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                  .flatMap(\.windows).first(where: \.isKeyWindow)
        else { return nil }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: CGRect(x: -1000, y: 0, width: side, height: side), configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        // Not pushed down by the screen's safe area (the icon would land below the snapshot).
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        view.isInspectable = false
        // In the window (off screen), so WebKit draws it for the snapshot.
        window.addSubview(view)
        defer { view.removeFromSuperview() }
        let loader = Loader()
        view.navigationDelegate = loader
        let page = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
        <style>html,body{margin:0;background:transparent}img{display:block;width:\(Int(side))px;height:\(Int(side))px;object-fit:contain}</style>
        </head><body><img alt="" src="data:image/svg+xml;base64,\(svg.base64EncodedString())"></body></html>
        """
        guard await loader.load(page, in: view) else { return nil }
        let snapshot = WKSnapshotConfiguration()
        snapshot.rect = CGRect(x: 0, y: 0, width: side, height: side)
        snapshot.afterScreenUpdates = true
        guard let image = try? await view.takeSnapshot(configuration: snapshot) else { return nil }
        return image.pngData()
    }

    /// Waits for the page (and its image) to load; allows no navigation but the page itself.
    private final class Loader: NSObject, WKNavigationDelegate {
        private var done: CheckedContinuation<Bool, Never>?

        func load(_ html: String, in view: WKWebView) async -> Bool {
            await withCheckedContinuation { continuation in
                done = continuation
                view.loadHTMLString(html, baseURL: nil)
            }
        }

        private func finish(_ ok: Bool) {
            done?.resume(returning: ok)
            done = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(true) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(false) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            finish(false)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(false) }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.request.url?.absoluteString == "about:blank" && action.targetFrame?.isMainFrame == true ? .allow : .cancel
        }
    }
}
