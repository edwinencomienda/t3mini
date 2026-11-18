import SwiftUI

/// Tool content under a reply: images, pages, diagrams, status and sub-agent cards, video and
/// sound (ToolCards.swift), and a short note for any kind the app doesn't know yet.
struct BlockView: View {
    let block: Block

    var body: some View {
        switch block {
        case .image(let id, let caption):
            RemoteImage(id: id, caption: caption)
        case .html(let id, let title, let libraries):
            HtmlPageCard(id: id, title: title, libraries: libraries)
        case .diagram(let source, let title):
            DiagramCard(source: source, title: title)
        case .status(let info):
            StatusCard(info: info)
        case .delegation(let info):
            DelegationCard(info: info)
        case .video(let id, let caption):
            MediaCard(id: id, caption: caption, kind: .video)
        case .audio(let id, let caption):
            MediaCard(id: id, caption: caption, kind: .audio)
        case .other(let type, let title):
            CardRow(icon: "desktopcomputer", tint: .secondary,
                    title: title ?? label(for: type),
                    detail: "\(label(for: type)) · open this thread on your computer to see it", link: nil)
        }
    }

    private func label(for type: String) -> String {
        switch type {
        case "diagram": "Diagram"
        case "html": "Interactive page"
        case "video": "Video"
        case "audio": "Sound"
        default: "Content"
        }
    }

    private func icon(for status: String) -> String {
        switch status {
        case "done": "checkmark.circle.fill"
        case "failed": "xmark.octagon.fill"
        case "stopped": "stop.circle"
        case "waiting": "hourglass"
        default: "arrow.triangle.2.circlepath"
        }
    }

    private func tint(for status: String) -> Color {
        switch status {
        case "done": .green
        case "failed": .red
        case "waiting": .orange
        default: .secondary
        }
    }
}

private struct CardRow: View {
    let icon: String
    let tint: Color
    let title: String
    let detail: String?
    let link: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(tint).font(.body)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                if let detail, !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                }
                // Only https links, like the web app (status cards are checked on the server too).
                if let link, let url = URL(string: link), url.scheme == "https" {
                    Link(url.host() ?? link, destination: url).font(.footnote)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.appSurface, in: .rect(cornerRadius: 14))
    }
}

/// An image from the computer, loaded with this phone's session. Tap to see it full screen.
/// The conversation shows a copy shrunk to its size on screen; the viewer loads the full one.
struct RemoteImage: View {
    let id: String
    var caption: String?
    var maxHeight: CGFloat = 420
    @Environment(AppModel.self) private var model
    @State private var image: UIImage?
    @State private var failed = false
    @State private var showing = false

    /// Long side, in pixels, for the conversation: the screen's width at its scale, which is
    /// sharp at any size the chat shows (a tap opens the full image).
    static let chatPixels = 1400

    var body: some View {
        // Decoded before (this thread or another visit): no spinner, no jump.
        let shown = image ?? model.cachedDecodedImage(id, maxPixel: Self.chatPixels)
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let shown {
                    Image(uiImage: shown)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: maxHeight)
                        .clipShape(.rect(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(.separator).opacity(0.5)))
                        .onTapGesture { showing = true }
                        .accessibilityLabel(caption ?? "Image")
                        .accessibilityAddTraits(.isButton)
                } else if failed {
                    Label("Image couldn’t load", systemImage: "photo.badge.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 80)
                        .background(Color.appSurface, in: .rect(cornerRadius: 14))
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 160)
                        .background(Color.appSurface, in: .rect(cornerRadius: 14))
                }
            }
            if let caption, !caption.isEmpty {
                Text(caption).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .task(id: id) {
            guard image == nil else { return }
            do {
                image = try await model.decodedImage(id, maxPixel: Self.chatPixels)
                failed = image == nil
            } catch {
                failed = image == nil
            }
        }
        .fullScreenCover(isPresented: $showing) {
            if let shown { ImageViewer(id: id, preview: shown, caption: caption) }
        }
    }
}

/// Full screen: pinch to zoom, drag to pan, double-tap to zoom in or out, Done to close. Opens
/// at once with the conversation's copy, then swaps in the full-size picture.
private struct ImageViewer: View {
    let id: String
    let preview: UIImage
    let caption: String?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var full: UIImage?

    var body: some View {
        NavigationStack {
            ZoomableImage(image: full ?? model.cachedDecodedImage(id, maxPixel: nil) ?? preview)
                .ignoresSafeArea()
                .background(.black)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                    if let caption {
                        ToolbarItem(placement: .bottomBar) { Text(caption).font(.footnote).lineLimit(2) }
                    }
                }
                .toolbarBackground(.visible, for: .navigationBar)
                .preferredColorScheme(.dark)
                .task(id: id) { full = try? await model.decodedImage(id, maxPixel: nil) }
        }
    }
}
