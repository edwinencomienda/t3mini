import SwiftUI
import WebKit

// An agent's HTML page (show_html) in the reply. The HTML is untrusted (the agent may have copied
// it, or been tricked by something it read), so the web view is sealed off, like the web app's
// sandboxed iframe:
// - The page comes finished from the server with our Content-Security-Policy first: no network
//   at all (no fetch, WebSockets, external scripts, images, or fonts), only inline code.
// - It's loaded as a string with no base URL, so it has no origin of its own to reach, in a
//   throwaway data store: nothing it stores is kept, and it never sees this phone's session.
// - It can't navigate anywhere or open windows. A link you tap opens in Safari (http/https only).
// - The only thing it can tell the app is its height, a number, clamped.

/// The card in the reply: the page at its own height, with its title and a full-screen button.
struct HtmlPageCard: View {
    let id: String
    let title: String?
    let libraries: [String]
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @State private var page: String?
    @State private var failed = false
    @State private var height: CGFloat = 160
    @State private var fullScreen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(title ?? "Page", systemImage: "macwindow")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Button { fullScreen = true } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.footnote)
                }
                .buttonStyle(.borderless)
                .tint(.secondary)
                .disabled(page == nil)
                .accessibilityLabel("Full screen")
            }
            Group {
                if let page {
                    HtmlWebView(html: page, scrollable: false, height: $height)
                        .frame(height: height)
                } else if failed {
                    Label("This page couldn’t load", systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 80)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 160)
                }
            }
        }
        .padding(12)
        .background(Color.appSurface.opacity(0.6), in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
        .task(id: colorScheme) {
            do {
                page = try await model.htmlPage(id, dark: colorScheme == .dark, inline: true, libraries: libraries)
            } catch {
                failed = page == nil
            }
        }
        .fullScreenCover(isPresented: $fullScreen) {
            HtmlFullScreen(id: id, title: title, libraries: libraries)
        }
    }
}

/// The page on its own screen, scrolling inside like a normal web page.
private struct HtmlFullScreen: View {
    let id: String
    let title: String?
    let libraries: [String]
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var page: String?
    @State private var height: CGFloat = 0

    var body: some View {
        NavigationStack {
            Group {
                if let page {
                    HtmlWebView(html: page, scrollable: true, height: $height)
                        .padding(.horizontal, 16)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(title ?? "Page")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task(id: colorScheme) {
                page = try? await model.htmlPage(id, dark: colorScheme == .dark, inline: false, libraries: libraries)
            }
        }
    }
}

/// The sealed web view (see the notes at the top of this file).
struct HtmlWebView: UIViewRepresentable {
    let html: String
    let scrollable: Bool
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.dataDetectorTypes = []
        // The page's height reporter posts {t3html:'size', h} to its parent; with no parent frame
        // here that lands on the page itself, so this forwards just the number to the app.
        let forward = WKUserScript(
            source: "addEventListener('message',function(e){var d=e.data;if(d&&d.t3html==='size'&&typeof d.h==='number')window.webkit.messageHandlers.t3size.postMessage(d.h)})",
            injectionTime: .atDocumentStart, forMainFrameOnly: true)
        configuration.userContentController.addUserScript(forward)
        configuration.userContentController.add(context.coordinator, name: "t3size")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = scrollable
        view.scrollView.bounces = scrollable
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isInspectable = false
        context.coordinator.loaded = html
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        view.scrollView.isScrollEnabled = scrollable
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        view.loadHTMLString(html, baseURL: nil)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "t3size")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var height: Binding<CGFloat>
        var loaded = ""

        init(height: Binding<CGFloat>) { self.height = height }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let value = message.body as? Double, value.isFinite else { return }
            let next = CGFloat(min(max(value, 40), 4000))
            if abs(next - height.wrappedValue) > 0.5 { height.wrappedValue = next }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            // Our own load of the page (about:blank), and frames inside it (srcdoc, still under
            // the CSP). Anything else is the page trying to go somewhere.
            if action.navigationType == .other, action.request.url?.absoluteString == "about:blank" { return .allow }
            if action.targetFrame?.isMainFrame == false, action.request.url?.scheme == "about" { return .allow }
            if action.navigationType == .linkActivated, let url = action.request.url,
               ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                await UIApplication.shared.open(url)
            }
            return .cancel
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // target=_blank links: open in Safari when you tapped one, never a new web view.
            if action.navigationType == .linkActivated, let url = action.request.url,
               ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                UIApplication.shared.open(url)
            }
            return nil
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.loadHTMLString(loaded, baseURL: nil)
        }
    }
}
