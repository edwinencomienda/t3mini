import SwiftUI

/// A Mermaid diagram (show_diagram) in the reply: its title, the drawing at its own shape, and a
/// full-screen view to pinch and pan. Drawn by DiagramRenderer; shown as plain SVG in a sealed
/// web view that runs no scripts at all. If it can't be drawn, its source is shown instead.
struct DiagramCard: View {
    let source: String
    let title: String?
    @Environment(\.colorScheme) private var colorScheme
    @State private var drawing: DiagramRenderer.Drawing?
    @State private var problem: String?
    @State private var fullScreen = false

    private var dark: Bool { colorScheme == .dark }

    var body: some View {
        let shown = drawing ?? DiagramRenderer.shared.cached(source, dark: dark)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(title ?? "Diagram", systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Button { fullScreen = true } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.footnote)
                }
                .buttonStyle(.borderless)
                .tint(.secondary)
                .disabled(shown == nil)
                .accessibilityLabel("Full screen")
            }
            if let shown {
                SVGView(svg: shown.svg, zoomable: false)
                    .aspectRatio(shown.width / shown.height, contentMode: .fit)
                    .frame(maxWidth: shown.width, maxHeight: 520)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                    .onTapGesture { fullScreen = true }
                    .accessibilityLabel(title ?? "Diagram")
                    .accessibilityAddTraits(.isButton)
            } else if let problem {
                VStack(alignment: .leading, spacing: 8) {
                    Label("This diagram couldn’t be drawn: \(problem)", systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    CodeBlock(code: source, language: "mermaid")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 140)
            }
        }
        .padding(12)
        .background(Color.appSurface.opacity(0.6), in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
        .task(id: "\(dark)|\(source)") {
            do {
                drawing = try await DiagramRenderer.shared.draw(source, dark: dark)
                problem = nil
            } catch {
                problem = error.localizedDescription
            }
        }
        .fullScreenCover(isPresented: $fullScreen) {
            if let shown { DiagramFullScreen(drawing: shown, title: title) }
        }
    }
}

/// The diagram on its own screen: pinch to zoom, drag to pan (the web view's own zooming).
private struct DiagramFullScreen: View {
    let drawing: DiagramRenderer.Drawing
    let title: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SVGView(svg: drawing.svg, zoomable: true)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(title ?? "Diagram")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
    }
}

/// SVG in the sealed web view (HtmlWebView): a page with a CSP that allows no scripts, no network,
/// and no navigation, so the drawing can only be looked at.
private struct SVGView: View {
    let svg: String
    let zoomable: Bool
    @State private var height: CGFloat = 0

    var body: some View {
        HtmlWebView(html: Self.page(svg, zoomable: zoomable), scrollable: zoomable, height: $height)
    }

    static func page(_ svg: String, zoomable: Bool) -> String {
        let viewport = zoomable
            ? "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=8, user-scalable=yes"
            : "width=device-width, initial-scale=1, user-scalable=no"
        let layout = zoomable
            ? "html,body{height:100%}body{display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}"
            : ""
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="\(viewport)">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
        <style>html,body{margin:0;background:transparent}\(layout)svg{display:block;width:100%;height:auto;max-width:100%!important;max-height:100%}</style>
        </head><body>\(svg)</body></html>
        """
    }
}
