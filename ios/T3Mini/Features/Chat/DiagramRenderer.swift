import UIKit
import WebKit

/// Draws Mermaid diagrams (show_diagram) into SVG, like the web app's Diagram.tsx: same colors,
/// `securityLevel: 'strict'` (no HTML labels, scripts, or click handlers), wide flowcharts turned
/// top-to-bottom for the phone.
///
/// One hidden web view loads Mermaid (bundled with the app, ~5 MB) once and draws every diagram;
/// drawings are remembered by source and theme, so a thread you come back to shows them at once.
/// The diagrams themselves are then shown as plain SVG in a sealed web view with no scripts at
/// all (DiagramView.swift). The hidden one is sealed too: no network (CSP), no navigation, a
/// throwaway data store, and Mermaid's source is the only code it runs besides ours.
@MainActor
final class DiagramRenderer: NSObject, WKNavigationDelegate {
    static let shared = DiagramRenderer()

    struct Drawing: Hashable, Sendable {
        let svg: String
        /// The SVG's own size (its viewBox), for the card's shape.
        let width: Double
        let height: Double
    }

    enum Failure: LocalizedError {
        case unavailable
        case invalid(String)
        var errorDescription: String? {
            switch self {
            case .unavailable: "Diagrams aren’t available in this build."
            case .invalid(let message): message
            }
        }
    }

    private var webView: WKWebView?
    private var loaded = false
    private var waiting: [CheckedContinuation<Bool, Never>] = []
    private var cache: [String: Drawing] = [:]
    private var order: [String] = []

    private static func key(_ source: String, dark: Bool) -> String { (dark ? "dark\n" : "light\n") + source }

    func cached(_ source: String, dark: Bool) -> Drawing? { cache[Self.key(source, dark: dark)] }

    func draw(_ source: String, dark: Bool) async throws -> Drawing {
        let key = Self.key(source, dark: dark)
        if let hit = cache[key] { return hit }
        guard await load(), let webView else { throw Failure.unavailable }
        let result = try await webView.callAsyncJavaScript(
            "return await window.t3draw(source, dark)",
            arguments: ["source": Self.phoneFriendly(source), "dark": dark], in: nil, contentWorld: .page)
        guard let object = result as? [String: Any] else { throw Failure.invalid("The diagram couldn’t be drawn.") }
        if let message = object["error"] as? String { throw Failure.invalid(message) }
        guard let svg = object["svg"] as? String, let size = Self.size(of: svg) else {
            throw Failure.invalid("The diagram couldn’t be drawn.")
        }
        let drawing = Drawing(svg: svg, width: size.width, height: size.height)
        cache[key] = drawing
        order.append(key)
        if order.count > 100 { cache[order.removeFirst()] = nil }
        return drawing
    }

    /// Wide flowcharts (`flowchart LR` / `graph RL`) drawn top to bottom, as the web app does on
    /// narrow screens; a phone is always narrow.
    nonisolated static func phoneFriendly(_ source: String) -> String {
        guard let match = source.firstMatch(of: /(?m)^(\s*(?:flowchart|graph))[ \t]+(?:LR|RL)\b/) else { return source }
        return source.replacingCharacters(in: match.range, with: match.output.1 + " TB")
    }

    /// The SVG's width and height from its viewBox.
    nonisolated static func size(of svg: String) -> (width: Double, height: Double)? {
        guard let match = svg.firstMatch(of: /viewBox="\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/),
              let width = Double(match.output.3), let height = Double(match.output.4), width > 0, height > 0
        else { return nil }
        return (width, height)
    }

    // MARK: The hidden web view

    private func load() async -> Bool {
        if loaded { return true }
        if webView == nil { start() }
        guard webView != nil else { return false }
        return await withCheckedContinuation { waiting.append($0) }
    }

    private func start() {
        guard let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js"),
              let mermaid = try? String(contentsOf: url, encoding: .utf8) else { return }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(
            WKUserScript(source: mermaid, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: CGRect(x: -2000, y: 0, width: 800, height: 600), configuration: configuration)
        view.navigationDelegate = self
        view.isUserInteractionEnabled = false
        view.alpha = 0
        view.accessibilityElementsHidden = true
        view.isInspectable = false
        // In the window (off screen), so WebKit lays out text and Mermaid can measure it.
        let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow }
        window?.addSubview(view)
        webView = view
        view.loadHTMLString(Self.page, baseURL: nil)
    }

    private func finish(_ ok: Bool) {
        loaded = ok
        if !ok {
            webView?.removeFromSuperview()
            webView = nil
        }
        let continuations = waiting
        waiting = []
        continuations.forEach { $0.resume(returning: ok) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(true) }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(false) }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(false)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url?.absoluteString == "about:blank" && action.targetFrame?.isMainFrame == true ? .allow : .cancel
    }

    /// Starts over the next time if WebKit dropped the page (memory pressure).
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        webView.removeFromSuperview()
        self.webView = nil
    }

    /// The renderer page: Mermaid's config, ported from src/components/Diagram.tsx, and one draw at
    /// a time (Mermaid's config is global).
    private static let page = """
    <!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
    </head><body><script>
    (function () {
      var palettes = {
        light: { background: '#ffffff', node: '#f4f4f5', nodeBorder: '#d4d4d8', text: '#27272a', muted: '#71717a',
          line: '#a1a1aa', cluster: '#fafafa', clusterBorder: '#e4e4e7', accent: '#eef2ff', accentBorder: '#c7d2fe',
          note: '#fffbeb', noteBorder: '#fcd34d' },
        dark: { background: '#1c1c1c', node: '#252528', nodeBorder: '#45454c', text: '#f4f4f5', muted: '#a1a1aa',
          line: '#7a7a82', cluster: '#212123', clusterBorder: '#38383d', accent: '#1e1b4b', accentBorder: '#4338ca',
          note: '#292211', noteBorder: '#a16207' }
      };
      var series = ['#6366f1','#14b8a6','#f59e0b','#ec4899','#0ea5e9','#84cc16','#a855f7','#f97316','#10b981','#ef4444','#64748b','#eab308'];
      var font = "-apple-system, BlinkMacSystemFont, system-ui, sans-serif";
      function numbered(prefix, from, out) { series.forEach(function (c, i) { out[prefix + (i + from)] = c; }); }
      function config(dark) {
        var c = dark ? palettes.dark : palettes.light;
        var v = { darkMode: dark, fontFamily: font, fontSize: '14px', background: c.background,
          primaryColor: c.node, primaryBorderColor: c.nodeBorder, primaryTextColor: c.text,
          secondaryColor: c.accent, secondaryBorderColor: c.accentBorder, secondaryTextColor: c.text,
          tertiaryColor: c.cluster, tertiaryBorderColor: c.clusterBorder, tertiaryTextColor: c.text,
          mainBkg: c.node, nodeBorder: c.nodeBorder, nodeTextColor: c.text, textColor: c.text, titleColor: c.text,
          lineColor: c.line, defaultLinkColor: c.line, edgeLabelBackground: c.background,
          clusterBkg: c.cluster, clusterBorder: c.clusterBorder, noteBkgColor: c.note, noteBorderColor: c.noteBorder,
          noteTextColor: c.text, actorBkg: c.node, actorBorder: c.nodeBorder, actorTextColor: c.text,
          actorLineColor: c.clusterBorder, signalColor: c.muted, signalTextColor: c.text, labelBoxBkgColor: c.node,
          labelBoxBorderColor: c.nodeBorder, labelTextColor: c.text, loopTextColor: c.muted,
          activationBkgColor: c.accent, activationBorderColor: c.accentBorder,
          sequenceNumberColor: dark ? '#111111' : '#ffffff', altBackground: c.cluster,
          attributeBackgroundColorOdd: c.background, attributeBackgroundColorEven: c.cluster,
          sectionBkgColor: c.cluster, altSectionBkgColor: c.background, sectionBkgColor2: c.cluster,
          taskBkgColor: series[0], taskBorderColor: series[0], taskTextColor: '#ffffff', taskTextOutsideColor: c.text,
          activeTaskBkgColor: c.accent, activeTaskBorderColor: series[0], doneTaskBkgColor: c.nodeBorder,
          doneTaskBorderColor: c.nodeBorder, critBkgColor: '#ef4444', critBorderColor: '#ef4444',
          gridColor: c.clusterBorder, todayLineColor: '#ef4444', pieOpacity: '1', pieStrokeColor: c.background,
          pieOuterStrokeColor: c.clusterBorder, pieSectionTextColor: '#ffffff', pieTitleTextColor: c.text,
          pieLegendTextColor: c.text, commitLabelColor: c.text, commitLabelBackground: c.node };
        numbered('pie', 1, v); numbered('git', 0, v); numbered('cScale', 0, v);
        series.forEach(function (_, i) { v['cScaleLabel' + i] = '#ffffff'; });
        return { startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: font, maxTextSize: 50000,
          flowchart: { padding: 14 }, sequence: { mirrorActors: false, actorMargin: 60, boxMargin: 8 },
          gantt: { fontSize: 12, sectionFontSize: 12, barHeight: 24, barGap: 6, topPadding: 44, leftPadding: 80,
            gridLineStartPadding: 36, axisFormat: '%b %d' },
          themeVariables: v };
      }
      var queue = Promise.resolve(), counter = 0;
      async function render(source, dark) {
        var id = 't3d' + (++counter);
        try {
          mermaid.initialize(config(dark));
          await mermaid.parse(source);
          var out = await mermaid.render(id, source);
          return { svg: out.svg };
        } catch (e) {
          return { error: String((e && e.message) || e).slice(0, 300) };
        } finally {
          var a = document.getElementById(id); if (a) a.remove();
          var b = document.getElementById('d' + id); if (b) b.remove();
        }
      }
      window.t3draw = function (source, dark) {
        var next = queue.then(function () { return render(source, dark); });
        queue = next.catch(function () {});
        return next;
      };
    })();
    </script></body></html>
    """
}
