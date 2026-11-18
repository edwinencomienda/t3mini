import SwiftUI

/// One thread as a conversation: your messages on the right, the agent's on the left, what it's
/// doing at the bottom, and the composer.
struct ChatView: View {
    let threadId: String
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var sending = false
    @State private var problem: String?
    @FocusState private var composerFocused: Bool

    private var thread: ChatThread? { model.openThread?.id == threadId ? model.openThread : nil }
    private var summary: ThreadSummary? { model.threads.first { $0.id == threadId } }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 18) {
                    if let thread {
                        ForEach(visibleMessages(thread)) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                        }
                        if thread.info.status.isRunning {
                            WorkingRow(activity: thread.activities.last { $0.status == "running" } ?? thread.activities.last)
                        }
                        if let error = thread.info.error, thread.info.status == .failed {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ForEach(thread.info.approvals) { approval in
                            ApprovalCard(approval: approval)
                        }
                    } else {
                        ProgressView().padding(.top, 60)
                    }
                    Color.clear.frame(height: 1).id(bottomId)
                }
                // Roomy margins, and the chat's own text size: smaller than the system body text,
                // like ChatGPT and Claude (it follows the user's text size setting).
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 8)
                .font(.callout)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: scrollKey) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomId, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(thread?.info.title ?? summary?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Like a Messages conversation: the project's avatar with the thread's name under it.
            ToolbarItem(placement: .principal) {
                let cwd = thread?.info.cwd ?? summary?.cwd ?? ""
                HStack(spacing: 8) {
                    ProjectAvatar(name: model.projectName(for: cwd), project: model.project(at: cwd), size: 30)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(thread?.info.title ?? summary?.title ?? "Thread")
                            .font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text("\(model.projectName(for: cwd)) · \((thread?.info.provider ?? summary?.provider ?? .claude).label)")
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .frame(maxWidth: 260)
            }
        }
        .onAppear { model.open(threadId) }
    }

    private let bottomId = "bottom"

    /// Changes whenever something new appears at the bottom, to follow it.
    private var scrollKey: String {
        guard let thread else { return "" }
        let last = thread.messages.last
        return "\(thread.messages.count)-\(last?.text.count ?? 0)-\(last?.blocks?.count ?? 0)-\(thread.activities.count)-\(thread.info.approvals.count)"
    }

    private func visibleMessages(_ thread: ChatThread) -> [Message] {
        thread.messages.filter {
            !$0.text.isEmpty || !($0.attachments ?? []).isEmpty || !($0.blocks ?? []).isEmpty || $0.report != nil
        }
    }

    // MARK: Composer

    private var running: Bool { thread?.info.status.isRunning ?? summary?.status.isRunning ?? false }

    private var hasDraft: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The message box, like iMessage: one floating capsule over the conversation (which scrolls
    /// behind it), with the send (or stop) button inside on the right.
    private var composer: some View {
        VStack(spacing: 6) {
            if let problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .floatingBackground(in: RoundedRectangle(cornerRadius: 16))
            }
            HStack(alignment: .bottom, spacing: 6) {
                TextField(running ? "Steer the agent…" : "Message", text: $draft, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    .padding(.leading, 16)
                    .padding(.vertical, 11)
                if running && !hasDraft {
                    Button {
                        Task { await act { try await model.stop() } }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(Color.red, in: Circle())
                    }
                    .accessibilityLabel("Stop")
                    .padding(5)
                } else {
                    Button {
                        Task { await send() }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(hasDraft ? Color.accentColor : Color(.systemGray3), in: Circle())
                    }
                    .disabled(!hasDraft || sending)
                    .accessibilityLabel("Send")
                    .padding(5)
                }
            }
            .floatingBackground(in: RoundedRectangle(cornerRadius: 22))
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .animation(.snappy(duration: 0.2), value: running && !hasDraft)
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        defer { sending = false }
        let saved = draft
        draft = ""
        if await !act({ try await model.send(text) }) { draft = saved }
    }

    @discardableResult
    private func act(_ action: () async throws -> Void) async -> Bool {
        problem = nil
        do {
            try await action()
            return true
        } catch {
            problem = error.localizedDescription
            return false
        }
    }
}

/// "Working · Run · bun test" with a spinner, under the last message.
struct WorkingRow: View {
    let activity: Activity?

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(activity?.line ?? "Working…")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
        }
        .padding(.vertical, 4)
    }
}

extension View {
    /// The floating look of iOS's own bars: Liquid Glass on iOS 26, a blurred material before.
    @ViewBuilder func floatingBackground(in shape: some Shape) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular.interactive(), in: shape)
        } else {
            background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color(.separator).opacity(0.4), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.08), radius: 10, y: 2)
        }
    }
}
