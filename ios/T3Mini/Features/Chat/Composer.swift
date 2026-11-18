import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

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
    @State private var showingPhotos = false
    @State private var showingCamera = false
    @State private var showingFiles = false
    @State private var uploadingFiles = 0
    @State private var pending: [PendingPhoto] = []
    @State private var dictation = LiveDictation()
    /// Settings → Dictation (read so the mic button follows a change there).
    @AppStorage(DictationEngine.key) private var dictationEngine = ""
    /// What was typed before dictation started; the live words go after it.
    @State private var dictationBase = ""
    @State private var problem: String?
    @FocusState private var focused: Bool

    /// A picked photo: shown at once, uploaded in the background.
    struct PendingPhoto: Identifiable {
        let id = UUID()
        let preview: UIImage
        var attachment: Attachment?
        var failed = false
    }

    private var uploading: Bool { uploadingFiles > 0 || pending.contains { $0.attachment == nil && !$0.failed } }
    private var ready: [Attachment] { pending.compactMap(\.attachment) }
    /// Send works while dictating too: it finishes the recording, adds its words, and sends.
    private var canSend: Bool {
        (hasContent || dictation.active) && !uploading && !dictation.finishing
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
                if dictation.active || dictation.finishing || dictation.preparing { recordingLine }
                // One line to start, like Claude's; grows as you type. While dictating, the words
                // appear as you say them: settled ones in the normal color, the ones still being
                // worked out muted (editing waits until you stop).
                Group {
                    if dictation.active || dictation.finishing {
                        liveWords
                    } else {
                        TextField(placeholder, text: $draft, axis: .vertical)
                            .lineLimit(1...8)
                            .focused($focused)
                    }
                }
                .font(.body)
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
        .photosPicker(isPresented: $showingPhotos, selection: $photos,
                      maxSelectionCount: max(1, 10 - pending.count), matching: .images)
        .fullScreenCover(isPresented: $showingCamera) {
            CameraPicker { data in
                showingCamera = false
                if let data { Task { await addImage(data) } }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { await addFiles(urls) }
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

    /// What's typed plus what you've said, the unsettled words muted. Long dictation keeps its
    /// newest words in view (the start gives way).
    private var liveWords: some View {
        let settled = Self.joined(dictationBase, dictation.committed)
        let pending = dictation.interim
        let gap = !settled.isEmpty && !pending.isEmpty && !settled.hasSuffix(" ") && !settled.hasSuffix("\n") ? " " : ""
        return Group {
            if settled.isEmpty && pending.isEmpty {
                Text("Listening…").foregroundStyle(.tertiary)
            } else {
                Text("\(Text(settled))\(Text(gap + pending).foregroundStyle(.secondary))")
            }
        }
        .lineLimit(8)
        .truncationMode(.head)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(nil, value: pending)
        .accessibilityLabel(settled + gap + pending)
    }

    private var placeholder: String {
        if running { return "Steer the agent…" }
        return "Message \(thread?.info.provider.label ?? "the agent")"
    }

    // MARK: Controls

    private var controls: some View {
        HStack(spacing: 8) {
            // Like Claude's +: take a photo, pick photos, or attach a file.
            Menu {
                if CameraPicker.available {
                    Button { showingCamera = true } label: { Label("Camera", systemImage: "camera") }
                        .disabled(pending.count >= 10)
                }
                Button { showingPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                    .disabled(pending.count >= 10)
                Button { showingFiles = true } label: { Label("Files", systemImage: "folder") }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: 36, height: 36)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(dictation.active)
            .accessibilityLabel("Add a photo or file")

            if let thread {
                ModelChip(thread: thread, action: editSettings)
            }
            Spacer(minLength: 4)

            if model.dictationAvailable || (dictationEngine != DictationEngine.computer.rawValue && DictationEngine.current == .iphone) {
                Button { Task { await toggleDictation() } } label: {
                    Image(systemName: dictation.active ? "stop.fill" : "mic")
                        .font(.system(size: dictation.active ? 12 : 16, weight: .medium))
                        .foregroundStyle(dictation.active ? .white : .primary)
                        .frame(width: 36, height: 36)
                        .background(dictation.active ? AnyShapeStyle(Color.red) : AnyShapeStyle(Color(.tertiarySystemFill)),
                                    in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(dictation.finishing || dictation.preparing)
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
                        if uploading { ProgressView().tint(Color(.systemBackground)) } else {
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
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                problem = "Couldn’t read that photo."
                continue
            }
            await addImage(data)
        }
    }

    /// Files from the Files app: images are attached like photos; anything else is saved on the
    /// computer (POST /api/uploads, kind "file", up to 25 MB, like dropping a file on the web) and
    /// its path goes into the message for the agent to read.
    private func addFiles(_ urls: [URL]) async {
        problem = nil
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                problem = "Couldn’t read \(url.lastPathComponent)."
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension)
            if type?.conforms(to: .image) == true, pending.count < 10 {
                await addImage(data)
                continue
            }
            guard data.count <= 25 * 1024 * 1024 else {
                problem = "\(url.lastPathComponent) is over 25 MB."
                continue
            }
            uploadingFiles += 1
            defer { uploadingFiles -= 1 }
            do {
                let path = try await model.uploadFile(data, name: url.lastPathComponent,
                                                      mimeType: type?.preferredMIMEType ?? "application/octet-stream")
                // Quoted when it has spaces, so the agent reads it as one path (like the web).
                let formatted = path.contains(" ") ? "\"\(path)\"" : path
                draft = Self.joined(draft, formatted) + " "
            } catch {
                problem = error.localizedDescription
            }
        }
    }

    /// A photo (picked, taken, or from Files): resized like the web app, then uploaded.
    private func addImage(_ data: Data) async {
        if true {
            guard let prepared = await Task.detached(operation: { ImagePrep.prepare(data) }).value else {
                problem = "Couldn’t read that photo."
                return
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
            if dictation.preparing {
                ProgressView().controlSize(.small)
                Text("Getting dictation ready…").foregroundStyle(.secondary)
            } else if dictation.finishing {
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
            let onDevice = DictationEngine.current == .iphone
            let request = model.dictationRequest()
            guard onDevice || request != nil else { return }
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
        // Optimistic: the box clears and the message shows in the chat at once (AppModel.send);
        // only if it couldn't be sent does it come back here, unless you've started a new one.
        problem = nil
        let saved = (draft, pending)
        draft = ""
        pending = []
        if let failure = await send(text, attachments) {
            if draft.isEmpty && pending.isEmpty { (draft, pending) = saved }
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
