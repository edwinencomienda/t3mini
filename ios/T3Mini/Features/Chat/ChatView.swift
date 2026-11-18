import SwiftUI

/// One thread as a conversation: your messages on the right, the agent's on the left, what it's
/// doing at the bottom, and the composer.
struct ChatView: View {
    let threadId: String
    @Environment(AppModel.self) private var model
    @State private var editingSettings = false
    /// The thread's branch (GET /api/threads/:id/git), checked when it opens and after each turn.
    @State private var branch: GitInfo?
    /// How many of the latest turns are drawn; "Show earlier" adds more (like the web app's
    /// firstTurns / OlderTurns).
    @State private var shownTurns = ChatView.turnPage
    static let turnPage = 20

    private var thread: ChatThread? { model.openThread?.id == threadId ? model.openThread : nil }
    private var summary: ThreadSummary? { model.threads.first { $0.id == threadId } }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // A plain VStack, not Lazy: turns are tall and vary a lot, and a lazy stack's height
                // guesses left the scroll stopping short of the bottom. Only the latest turns are
                // drawn, so long threads stay quick.
                VStack(spacing: 18) {
                    if let thread {
                        let all = turns(of: thread)
                        if all.count > shownTurns {
                            Button {
                                shownTurns += Self.turnPage
                            } label: {
                                Label("Show earlier messages", systemImage: "arrow.up")
                                    .font(.footnote.weight(.medium))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                                    .background(Color(.tertiarySystemFill), in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                        }
                        ForEach(all.suffix(shownTurns)) { turn in
                            TurnView(turn: turn)
                        }
                        if thread.info.status.isRunning {
                            WorkingRow(activity: thread.activities.last { $0.status == "running" } ?? thread.activities.last,
                                       since: all.last?.startedAt)
                        } else if thread.info.status != .waiting, let last = all.last, last.user != nil,
                                  let finished = last.finishLabel() {
                            // "Worked for 24s · done 2:00 PM", like the web app.
                            Text(finished)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
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
            // A tap on the conversation closes the keyboard (links and buttons still work).
            .simultaneousGesture(TapGesture().onEnded {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            })
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
                        HStack(spacing: 4) {
                            Text(model.projectName(for: cwd)).lineLimit(1)
                            if let name = branchName {
                                Text("·")
                                Image(systemName: "arrow.triangle.branch")
                                Text(name).lineLimit(1).truncationMode(.middle)
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: 260)
            }
        }
        .onAppear { model.open(threadId) }
        // On opening, and whenever a turn ends (the agent may have switched branches).
        .task(id: "\(threadId)|\(thread?.info.status.isRunning == true)") {
            if thread?.info.status.isRunning != true { branch = await model.branch(of: threadId) }
        }
        .sheet(isPresented: $editingSettings) {
            if let thread { ThreadSettingsSheet(thread: thread) }
        }
    }

    private let bottomId = "bottom"

    /// A worktree thread's own branch, else the folder's current branch (short hash when detached).
    private var branchName: String? {
        if let worktree = thread?.info.worktree?.branch, !worktree.isEmpty { return worktree }
        return branch?.branch
    }

    /// Changes whenever something new appears at the bottom, to follow it.
    private var scrollKey: String {
        guard let thread else { return "" }
        let last = thread.messages.last
        return "\(thread.messages.count)-\(last?.text.count ?? 0)-\(last?.blocks?.count ?? 0)-\(thread.activities.count)-\(thread.info.approvals.count)"
    }

    private func turns(of thread: ChatThread) -> [Turn] {
        Turn.build(messages: visibleMessages(thread), activities: thread.activities,
                   running: thread.info.status.isRunning || thread.info.status == .waiting,
                   completedAt: thread.info.completedAt, status: thread.info.status)
    }

    private func visibleMessages(_ thread: ChatThread) -> [Message] {
        thread.messages.filter {
            !$0.text.isEmpty || !($0.attachments ?? []).isEmpty || !($0.blocks ?? []).isEmpty || $0.report != nil
        }
    }

    // MARK: Composer

    private var running: Bool { thread?.info.status.isRunning ?? summary?.status.isRunning ?? false }

    /// The message box (Composer.swift): sending, steering, stopping, photos, and dictation.
    private var composer: some View {
        Composer(
            thread: thread,
            running: running,
            editSettings: { editingSettings = true },
            send: { text, attachments in
                do {
                    try await model.send(text, attachments: attachments)
                    return nil
                } catch {
                    return error.localizedDescription
                }
            },
            stop: { try? await model.stop() })
    }
}

/// "Working · Run · bun test" with a spinner, under the last message.
struct WorkingRow: View {
    let activity: Activity?
    /// When the turn started: the counter at the end ("42s"), ticking each second on its own so
    /// the conversation doesn't redraw.
    var since: String?

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(activity?.line ?? "Working…")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if let start = since.flatMap(RelativeTime.parse) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(Self.counter(context.date.timeIntervalSince(start)))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// "42s", "3m 5s", like the web app's working line.
    static func counter(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        return total < 60 ? "\(total)s" : "\(total / 60)m \(total % 60)s"
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
