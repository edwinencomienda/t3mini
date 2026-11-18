import ImageIO
import SwiftUI
import UIKit

/// The animated Claude and Codex characters from the web app (public/mascots, bundled), for the
/// working line: thinking, working, and celebrating when a turn finishes (that one plays once).
/// Same files and rules as the web (src/mascots.ts): off with iOS's Reduce Motion or when
/// Settings → Appearance → Animations is off on the computer, leaving the plain spinner.
struct Mascot: View {
    enum Mood: String { case thinking, working, celebrating }

    let provider: Provider
    let mood: Mood
    var size: CGFloat = 40

    var body: some View {
        GIFView(name: "\(provider.rawValue)-\(mood.rawValue)", once: mood == .celebrating)
            .frame(width: size, height: size)
            // The GIFs leave room above the character (thought bubbles, confetti): lift it so it
            // lines up with the text, by the web app's measurements (at 40 px).
            .offset(y: -Self.lift["\(provider.rawValue)-\(mood.rawValue)", default: 0] * size / 40)
            .accessibilityHidden(true)
    }

    private static let lift: [String: CGFloat] = [
        "claude-working": 7, "claude-thinking": 6, "claude-celebrating": 4,
        "codex-working": 4, "codex-thinking": 2, "codex-celebrating": 1,
    ]
}

extension View {
    /// Whether the characters show: on unless Reduce Motion is on or animations are off on the
    /// computer (shared setting).
    @MainActor static func mascotsOn(model: AppModel, reduceMotion: Bool) -> Bool {
        !reduceMotion && model.ui?.animations != false
    }
}

/// A GIF from the app's bundled mascots folder, decoded once and kept (they're small).
private struct GIFView: UIViewRepresentable {
    let name: String
    let once: Bool

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView()
        view.contentMode = .scaleAspectFit
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        show(in: view)
        return view
    }

    func updateUIView(_ view: UIImageView, context: Context) {
        if view.accessibilityIdentifier != name { show(in: view) }
    }

    private func show(in view: UIImageView) {
        view.accessibilityIdentifier = name
        view.stopAnimating()
        guard let gif = GIFCache.shared.gif(name) else { view.image = nil; return }
        view.animationImages = gif.frames
        view.animationDuration = gif.duration
        view.animationRepeatCount = once ? 1 : 0
        // Played once, it rests on its last frame.
        view.image = once ? gif.frames.last : gif.frames.first
        view.startAnimating()
    }
}

@MainActor
private final class GIFCache {
    static let shared = GIFCache()
    struct GIF { let frames: [UIImage]; let duration: TimeInterval }
    private var cache: [String: GIF] = [:]

    func gif(_ name: String) -> GIF? {
        if let hit = cache[name] { return hit }
        guard let url = Bundle.main.url(forResource: name, withExtension: "gif", subdirectory: "mascots")
                ?? Bundle.main.url(forResource: name, withExtension: "gif"),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        var frames: [UIImage] = []
        var duration: TimeInterval = 0
        for index in 0..<CGImageSourceGetCount(source) {
            guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
            frames.append(UIImage(cgImage: image))
            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double)
                ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
            duration += delay < 0.02 ? 0.1 : delay
        }
        guard !frames.isEmpty else { return nil }
        let result = GIF(frames: frames, duration: duration)
        cache[name] = result
        return result
    }
}
