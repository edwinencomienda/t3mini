import SwiftUI

/// Tool content under a reply: images, status cards, sub-agent cards, and a short note for the
/// kinds the app can't draw yet (diagrams, HTML pages, video, audio).
struct BlockView: View {
    let block: Block

    var body: some View {
        switch block {
        case .image(let id, let caption):
            RemoteImage(id: id, caption: caption)
        case .html(let id, let title, let libraries):
            HtmlPageCard(id: id, title: title, libraries: libraries)
        case .status(let title, let status, let detail, let url):
            CardRow(icon: icon(for: status), tint: tint(for: status), title: title, detail: detail, link: url)
        case .delegation(let title, let status, let step):
            CardRow(icon: status == "running" ? "person.2.wave.2" : icon(for: status), tint: tint(for: status),
                    title: "Sub-agent: \(title)", detail: step, link: nil)
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
        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 14))
    }
}

/// An image from the computer, loaded with this phone's session. Tap to see it full screen.
struct RemoteImage: View {
    let id: String
    var caption: String?
    var maxHeight: CGFloat = 420
    @Environment(AppModel.self) private var model
    @State private var image: UIImage?
    @State private var failed = false
    @State private var showing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let image {
                    Image(uiImage: image)
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
                        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 14))
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 160)
                        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 14))
                }
            }
            if let caption, !caption.isEmpty {
                Text(caption).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .task(id: id) {
            guard image == nil else { return }
            do {
                // Decoding a large screenshot is slow: off the main thread.
                let data = try await model.imageData(id)
                image = await Task.detached { UIImage(data: data)?.preparingForDisplay() }.value
                failed = image == nil
            } catch {
                failed = true
            }
        }
        .fullScreenCover(isPresented: $showing) {
            if let image { ImageViewer(image: image, caption: caption) }
        }
    }
}

/// Full screen, pinch to zoom, double-tap to zoom in or out, Done to close.
private struct ImageViewer: View {
    let image: UIImage
    let caption: String?
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        NavigationStack {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(scale)
                .offset(offset)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.black)
                .gesture(
                    MagnifyGesture()
                        .onChanged { scale = max(1, min(lastScale * $0.magnification, 6)) }
                        .onEnded { _ in
                            lastScale = scale
                            if scale == 1 { offset = .zero; lastOffset = .zero }
                        }
                        .simultaneously(with: DragGesture()
                            .onChanged { value in
                                guard scale > 1 else { return }
                                offset = CGSize(width: lastOffset.width + value.translation.width,
                                                height: lastOffset.height + value.translation.height)
                            }
                            .onEnded { _ in lastOffset = offset }))
                .onTapGesture(count: 2) {
                    withAnimation(.snappy) {
                        scale = scale > 1 ? 1 : 2.5
                        lastScale = scale
                        if scale == 1 { offset = .zero; lastOffset = .zero }
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                    if let caption {
                        ToolbarItem(placement: .bottomBar) { Text(caption).font(.footnote).lineLimit(2) }
                    }
                }
                .toolbarBackground(.visible, for: .navigationBar)
                .preferredColorScheme(.dark)
        }
    }
}
