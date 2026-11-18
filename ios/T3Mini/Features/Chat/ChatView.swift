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
    /// Near the bottom: new replies are followed, and the jump-to-latest button hides.
    @State private var atBottom = true
    @State private var startingThread = false
    @State private var problem: String?
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
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 120
            } action: { _, near in
                atBottom = near
            }
            // Follows new content only when you're at the bottom (or just sent something), so
            // reading back up isn't interrupted.
            .onChange(of: scrollKey) { _, _ in
                guard atBottom || thread?.messages.last?.role == .user else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomId, anchor: .bottom) }
            }
            .safeAreaInset(edge: .bottom) {
                composer
                    // The jump-to-latest button floats over the conversation, centered just
                    // above the message box; it doesn't change the layout.
                    .overlay(alignment: .top) {
                        if !atBottom {
                            Button {
                                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(bottomId, anchor: .bottom) }
                            } label: {
                                Image(systemName: "arrow.down")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(.primary)
                                    .frame(width: 40, height: 40)
                                    .floatingBackground(in: Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Scroll to the latest")
                            .offset(y: -52)
                            .transition(.opacity.combined(with: .scale(scale: 0.8)))
                        }
                    }
                    .animation(.easeOut(duration: 0.15), value: atBottom)
            }
        }
        .navigationTitle(thread?.info.title ?? summary?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        // No bar behind the header: the back button, title, and actions float as pills over
        // the conversation, which fades out softly under them.
        .toolbarBackground(.hidden, for: .navigationBar)
        .softTopEdge()
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
                .padding(.leading, 5)
                .padding(.trailing, 14)
                .padding(.vertical, 5)
                // A floating pill of its own, like Claude's, over the conversation.
                .floatingBackground(in: Capsule())
                .frame(maxWidth: 260)
            }
            .hidingSharedBackground()
            // Like Claude's: working spinner, a new thread in this project, and more.
            ToolbarItemGroup(placement: .topBarTrailing) {
                if running {
                    ProgressView().controlSize(.small)
                }
                Menu {
                    Button { editingSettings = true } label: {
                        Label("Agent settings", systemImage: "slider.horizontal.3")
                    }
                    .disabled(thread == nil)
                    if running {
                        Button(role: .destructive) { Task { try? await model.stop() } } label: {
                            Label("Stop", systemImage: "stop.circle")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("More")
                Button { Task { await newThreadHere() } } label: {
                    if startingThread { ProgressView().controlSize(.small) } else { Image(systemName: "square.and.pencil") }
                }
                .disabled(startingThread || (thread == nil && summary == nil))
                .accessibilityLabel("New thread in this project")
            }
        }
        .alert("Couldn’t start a thread", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(problem ?? "")
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

    /// A new thread in this thread's project, with the same agent and settings, opened in place
    /// of this one (back still goes to the list).
    private func newThreadHere() async {
        let cwd = thread?.info.cwd ?? summary?.cwd ?? ""
        let choice = thread?.info.settings ?? model.defaultChoice(for: summary?.provider ?? model.defaultProvider)
        startingThread = true
        defer { startingThread = false }
        do {
            if let id = try await model.createThread(project: model.project(at: cwd), choice: choice) {
                model.pendingOpen = id
            }
        } catch {
            problem = error.localizedDescription
        }
    }

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
    /// Content fades out softly under the floating header (iOS 26's scroll edge effect).
    @ViewBuilder func softTopEdge() -> some View {
        if #available(iOS 26.0, *) {
            scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            self
        }
    }

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

extension ToolbarContent {
    /// The title pill draws its own glass, so iOS 26's shared toolbar background stays off it.
    @ToolbarContentBuilder func hidingSharedBackground() -> some ToolbarContent {
        if #available(iOS 26.0, *) {
            sharedBackgroundVisibility(.hidden)
        } else {
            self
        }
    }
}
