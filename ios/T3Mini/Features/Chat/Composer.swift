import PhotosUI
import SwiftUI

/// The message box, laid out like the Claude app: the text on top, and under it + (photos), the
/// agent chip (model and reasoning; tap to change), the microphone (dictation through the
/// computer), and send (stop while the agent works and there's nothing to send).
struct Composer: View {
    let thread: ChatThread?
    let running: Bool
    let editSettings: () -> Void
    /// Sends; returns why it failed, or nil.
    let send: (String, [Attachment]) async -> String?
    let stop: () async -> Void

    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var photos: [PhotosPickerItem] = []
    @State private var pending: [PendingPhoto] = []
    @State private var dictation = LiveDictation()
    /// What was typed before dictation started; the live words go after it.
    @State private var dictationBase = ""
    @State private var sending = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    /// A picked photo: shown at once, uploaded in the background.
    struct PendingPhoto: Identifiable {
        let id = UUID()
        let preview: UIImage
        var attachment: Attachment?
        var failed = false
    }

    private var uploading: Bool { pending.contains { $0.attachment == nil && !$0.failed } }
    private var ready: [Attachment] { pending.compactMap(\.attachment) }
    /// Send works while dictating too: it finishes the recording, adds its words, and sends.
    private var canSend: Bool {
        (hasContent || dictation.active) && !sending && !uploading && !dictation.finishing
    }
    private var hasContent: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ready.isEmpty }

    var body: some View {
        VStack(spacing: 8) {
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .floatingBackground(in: RoundedRectangle(cornerRadius: 16))
            }
            VStack(alignment: .leading, spacing: 12) {
                if !pending.isEmpty { photoStrip }
                if dictation.active || dictation.finishing { recordingLine }
                // One line to start, like Claude's; grows as you type. While dictating, the words
                // appear here as you say them (editing waits until you stop).
                TextField(placeholder, text: $draft, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...8)
                    .focused($focused)
                    .disabled(dictation.active || dictation.finishing)
                    .padding(.horizontal, 8)
                    .padding(.top, 6)
                controls
            }
            .padding(10)
            // The glass goes behind the contents only: applied to the contents themselves it
            // washes them out (the send button looked disabled).
            .background {
                // Not .clear: glass on a fully transparent view may not be drawn at all.
                RoundedRectangle(cornerRadius: 30, style: .continuous)
                    .fill(Color(.systemBackground).opacity(0.02))
                    .floatingBackground(in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task { await add(items) }
        }
        .onDisappear { dictation.cancel() }
        .onChange(of: dictation.text) { _, words in
            guard dictation.active || dictation.finishing else { return }
            draft = Self.joined(dictationBase, words)
        }
        .onChange(of: dictation.problem) { _, message in
            if let message { problem = message }
        }
    }

    private var placeholder: String {
        if running { return "Steer the agent…" }
        return "Message \(thread?.info.provider.label ?? "the agent")"
    }

    // MARK: Controls

    private var controls: some View {
        HStack(spacing: 8) {
            PhotosPicker(selection: $photos, maxSelectionCount: max(1, 10 - pending.count), matching: .images) {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: 36, height: 36)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(pending.count >= 10 || dictation.active)
            .accessibilityLabel("Add photos")

            if let thread {
                ModelChip(thread: thread, action: editSettings)
            }
            Spacer(minLength: 4)

            if model.dictationAvailable {
                Button { Task { await toggleDictation() } } label: {
                    Image(systemName: dictation.active ? "stop.fill" : "mic")
                        .font(.system(size: dictation.active ? 12 : 16, weight: .medium))
                        .foregroundStyle(dictation.active ? .white : .primary)
                        .frame(width: 36, height: 36)
                        .background(dictation.active ? AnyShapeStyle(Color.red) : AnyShapeStyle(Color(.tertiarySystemFill)),
                                    in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(dictation.finishing)
                .accessibilityLabel(dictation.active ? "Stop dictating" : "Dictate")
            }

            if running && !hasContent && !dictation.active && !dictation.finishing {
                Button { Task { await stop() } } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Color.red, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop the agent")
            } else {
                Button { Task { await submit() } } label: {
                    Group {
                        if sending || uploading { ProgressView().tint(Color(.systemBackground)) } else {
                            Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
                        }
                    }
                    .foregroundStyle(canSend ? Color(.systemBackground) : Color(.secondaryLabel))
                    .frame(width: 36, height: 36)
                    .background(canSend ? Color.primary : Color(.tertiarySystemFill), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
    }

    // MARK: Photos

    private var photoStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pending) { photo in
                    Image(uiImage: photo.preview)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 64, height: 64)
                        .clipShape(.rect(cornerRadius: 12))
                        .overlay {
                            if photo.attachment == nil && !photo.failed {
                                RoundedRectangle(cornerRadius: 12).fill(.black.opacity(0.35))
                                ProgressView().tint(.white)
                            } else if photo.failed {
                                RoundedRectangle(cornerRadius: 12).fill(.black.opacity(0.5))
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                            }
                        }
                        .overlay(alignment: .topTrailing) {
                            Button { pending.removeAll { $0.id == photo.id } } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 18))
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .buttonStyle(.plain)
                            .offset(x: 6, y: -6)
                            .accessibilityLabel("Remove photo")
                        }
                }
            }
            .padding(.top, 6)
            .padding(.horizontal, 4)
        }
    }

    private func add(_ items: [PhotosPickerItem]) async {
        problem = nil
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let prepared = await Task.detached(operation: { ImagePrep.prepare(data) }).value
            else {
                problem = "Couldn’t read that photo."
                continue
            }
            let photo = PendingPhoto(preview: prepared.preview)
            pending.append(photo)
            Task {
                let index = { pending.firstIndex { $0.id == photo.id } }
                do {
                    let saved = try await model.uploadImage(prepared.jpeg, name: "Photo.jpg", mimeType: "image/jpeg")
                    if let i = index() { pending[i].attachment = saved }
                } catch {
                    if let i = index() { pending[i].failed = true }
                    problem = error.localizedDescription
                }
            }
        }
    }

    // MARK: Dictation

    private var recordingLine: some View {
        HStack(spacing: 10) {
            if dictation.finishing {
                ProgressView().controlSize(.small)
                Text("Finishing…").foregroundStyle(.secondary)
            } else {
                Circle().fill(.red).frame(width: 8, height: 8)
                    .opacity(0.4 + Double(dictation.level) * 0.6)
                Text(Duration.seconds(dictation.elapsed).formatted(.time(pattern: .minuteSecond)))
                    .monospacedDigit()
                LevelBars(level: dictation.level)
                Text("Listening…").foregroundStyle(.secondary)
            }
            Spacer()
        }
        .font(.subheadline)
        .padding(.horizontal, 6)
        .frame(minHeight: 24)
    }

    private func toggleDictation() async {
        problem = nil
        if dictation.active {
            await finishDictation()
            focused = true
        } else {
            guard let request = model.dictationRequest() else { return }
            focused = false
            dictationBase = draft
            if let failure = await dictation.start(request) { problem = failure }
        }
    }

    /// Stops listening and keeps the words (already in the box as they were said).
    private func finishDictation() async {
        let words = await dictation.stop()
        draft = Self.joined(dictationBase, words)
        if words.isEmpty && problem == nil { problem = "Didn’t catch anything. Try again a little closer." }
    }

    static func joined(_ base: String, _ words: String) -> String {
        guard !words.isEmpty else { return base }
        guard !base.isEmpty else { return words }
        return base + (base.hasSuffix(" ") || base.hasSuffix("\n") ? "" : " ") + words
    }

    // MARK: Sending

    private func submit() async {
        // Dictating: finish it first, so its words go out with what's typed.
        if dictation.active { await finishDictation() }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = ready
        guard !text.isEmpty || !attachments.isEmpty else { return }
        sending = true
        defer { sending = false }
        problem = nil
        let saved = (draft, pending)
        draft = ""
        pending = []
        if let failure = await send(text, attachments) {
            (draft, pending) = saved
            problem = failure
        }
    }
}

/// The model and reasoning, like Claude's "Sonnet 5.5 Medium" chip. Tap to change them.
struct ModelChip: View {
    let thread: ChatThread
    let action: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let settings = thread.info.settings
        let models = model.cachedModels(settings.provider, cwd: thread.info.cwd)
        let current = models.first { $0.id == settings.model }
            ?? (settings.model.isEmpty ? models.first { $0.isDefault == true || $0.id == "default" } : nil)
        let label = current.map { $0.id == "default" ? "Default" : $0.label } ?? (settings.model.isEmpty ? "Default" : settings.model)
        Button(action: action) {
            HStack(spacing: 6) {
                AgentLogo(provider: settings.provider, size: 13)
                Text(label).foregroundStyle(.primary).lineLimit(1)
                Text(AgentChoice.effortLabel(settings.effort.isEmpty ? (current?.defaultEffort ?? "") : settings.effort))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14)
            .frame(height: 36)
            .background(Color(.tertiarySystemFill), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Model and settings")
        .task(id: "\(settings.provider.rawValue)|\(thread.info.cwd)") {
            _ = await model.models(settings.provider, cwd: thread.info.cwd)
        }
    }
}

/// A small live level meter while recording.
private struct LevelBars: View {
    let level: Float

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<5, id: \.self) { index in
                Capsule()
                    .fill(.secondary)
                    .frame(width: 3, height: 6 + CGFloat(level) * CGFloat([10, 18, 24, 18, 10][index]))
            }
        }
        .animation(.easeOut(duration: 0.1), value: level)
        .frame(height: 30)
    }
}

/// Photos the way the web app sends them (src/attachments.ts → prepareImage): JPEG, at most
/// 2048 px on the long side, so HEIC and huge camera shots work and stay well under the agents'
/// image limits. Also a small preview for the message box.
enum ImagePrep {
    struct Prepared: @unchecked Sendable {
        let jpeg: Data
        let preview: UIImage
    }

    static func prepare(_ data: Data, maxSide: CGFloat = 2048) -> Prepared? {
        guard let image = UIImage(data: data) else { return nil }
        let scale = min(1, maxSide / max(image.size.width, image.size.height))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        var quality: CGFloat = 0.82
        var jpeg = resized.jpegData(compressionQuality: quality)
        // Keep it under ~4 MB (Claude refuses images over ~5 MB).
        while let current = jpeg, current.count > 4_000_000, quality > 0.4 {
            quality -= 0.15
            jpeg = resized.jpegData(compressionQuality: quality)
        }
        guard let jpeg else { return nil }
        let previewSide: CGFloat = 160
        let previewScale = previewSide / max(size.width, size.height)
        let previewSize = CGSize(width: size.width * previewScale, height: size.height * previewScale)
        let preview = UIGraphicsImageRenderer(size: previewSize, format: format).image { _ in
            resized.draw(in: CGRect(origin: .zero, size: previewSize))
        }
        return Prepared(jpeg: jpeg, preview: preview)
    }
}
