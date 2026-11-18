import SwiftUI

/// One thread as a conversation: your messages on the right, the agent's on the left, what it's
/// doing at the bottom, and the composer.
struct ChatView: View {
    let threadId: String
    @Environment(AppModel.self) private var model
    @State private var editingSettings = false
    /// How many of the latest turns are drawn; "Show earlier" adds more (like the web app's
    /// firstTurns / OlderTurns).
    @State private var shownTurns = ChatView.turnPage
    /// Near the bottom: new replies are followed, and the jump-to-latest button hides.
    @State private var atBottom = true
    /// Following the bottom: anything that grows below (an image or diagram loading, a reply
    /// streaming) keeps the view at the end. Only your own scrolling turns it off (scrolling up)
    /// or on (back down, or ↓).
    @State private var pinned = true
    @State private var userScrolling = false
    /// Opening a thread: the conversation stays hidden until it's at its end, like T3 Code's
    /// mobile feed, so you never see it lay out and scroll down (usually that's the first frame).
    @State private var landed = false
    @State private var endDistance: CGFloat = .infinity
    /// Where the conversation is scrolled, held by the scroll view itself (iOS 18). Asking it for
    /// the bottom edge is applied during layout, so it works even in the first frame of a thread
    /// that's already loaded (a ScrollViewReader jump then could land mid-thread).
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var landing: Task<Void, Never>?
    @State private var startingThread = false
    @State private var problem: String?
    /// The screen's width, to size the title pill so it never runs into the buttons.
    @State private var width: CGFloat = 0
    @State private var showingDetails = false
    @State private var showingChanges = false
    static let turnPage = 20

    private var thread: ChatThread? { model.openThread?.id == threadId ? model.openThread : nil }
    private var summary: ThreadSummary? { model.threads.first { $0.id == threadId } }

    var body: some View {
        ScrollViewReader { _ in
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
                            TurnView(turn: turn,
                                     live: turn.id == all.last?.id && (thread.info.status.isRunning || !sending.isEmpty)
                                        && thread.info.approvals.isEmpty,
                                     starting: thread.info.status == .starting || !thread.info.status.isRunning,
                                     provider: thread.info.provider)
                                .equatable()
                        }
                        // While it runs, the working line is part of the latest turn (TurnView).
                        if thread.info.status.isRunning || !sending.isEmpty {
                            EmptyView()
                        } else if thread.info.status != .waiting, let last = all.last, last.user != nil,
                                  let finished = last.finishLabel() {
                            // "Worked for 24s · done 2:00 PM", like the web app, with the
                            // character celebrating for a few seconds when it just finished.
                            HStack(spacing: 8) {
                                if thread.info.status == .completed, let at = thread.info.completedAt {
                                    Celebration(provider: thread.info.provider, at: at)
                                }
                                Text(finished)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
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
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom)
            // When content changes size (an image or page finishing loading above the text, a
            // reply growing): following the end, the scroll view itself keeps the bottom edge in
            // place during that layout; reading further up, it keeps what you're looking at still.
            .defaultScrollAnchor(pinned ? .bottom : .top, for: .sizeChanges)
            // Hidden only while landing (and only once there's a thread to show).
            .opacity(landed || thread == nil ? 1 : 0)
            .onChange(of: thread == nil, initial: true) { _, missing in
                guard !missing else { return }
                // Back from a sub-agent's or helper's thread: this one is drawn again.
                if landed { if pinned { position.scrollTo(edge: .bottom) } } else { land() }
            }
            // Landed: at the very end (within 2 points) with something laid out, so it shows now.
            // The true end includes the space under the message box and header (the content
            // insets): without it, the last lines hidden behind the message box counted as "at
            // the end".
            // While landing, how far from the end it is (constant once landed, so scrolling
            // doesn't redraw the view). At the end: shown, if it's still there a beat later (the
            // header and message box measuring in can move it for a frame).
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                landed ? 0 : Self.distanceFromEnd(geometry)
            } action: { _, distance in
                endDistance = distance
                guard !landed, distance <= 2, thread != nil else { return }
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(50))
                    if endDistance <= 2, thread != nil { landed = true }
                }
            }
            // The message box or header was measured (or changed size, or the keyboard moved):
            // the insets changed and the scroll view kept its top in place. Back to the end if
            // you're following it. Reopening a thread lays it out before they're known.
            .onScrollGeometryChange(for: [CGFloat].self) { geometry in
                [geometry.contentInsets.top, geometry.contentInsets.bottom, geometry.containerSize.height]
            } action: { _, _ in
                guard pinned, !userScrolling else { return }
                position.scrollTo(edge: .bottom)
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                Self.distanceFromEnd(geometry) <= 120
            } action: { _, near in
                atBottom = near
                if userScrolling { pinned = near }
            }
            .onScrollPhaseChange { _, phase in
                userScrolling = phase == .interacting || phase == .decelerating
                // A scroll that came to rest at the end follows the bottom again.
                if phase == .idle && atBottom { pinned = true }
            }
            // Content grew or shrank (an image, diagram, or page finished loading; a reply
            // streamed): stay at the end if you were there. Without animation, so it doesn't drift.
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
                guard pinned, !userScrolling, abs(new - old) > 0.5 else { return }
                // Backup for the anchor above.
                position.scrollTo(edge: .bottom)
                // Still landing: back to the end.
                if !landed { land() }
            }
            // Something new arrived: follow it if you're at the end (or just sent something), so
            // reading back up isn't interrupted.
            .onChange(of: scrollKey) { _, _ in
                if thread?.messages.last?.role == .user || !sending.isEmpty { pinned = true }
                guard pinned else { return }
                // Still landing (hidden): straight there, no animation.
                if !landed { position.scrollTo(edge: .bottom); return }
                withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(edge: .bottom) }
            }
            .safeAreaInset(edge: .bottom) {
                composer
                    // The jump-to-latest button floats over the conversation, centered just
                    // above the message box; it doesn't change the layout.
                    .overlay(alignment: .top) {
                        if !atBottom {
                            Button {
                                pinned = true
                                withAnimation(.easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
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
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .appScreen()
        .navigationTitle(thread?.info.title ?? summary?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        // Our title pill replaces the bar's own centered title (kept above for the back menu and
        // VoiceOver); without this the system draws it in the middle and squeezes the pill.
        .toolbar(removing: .title)
        // No bar behind the header: the back button, title, and actions float as pills over
        // the conversation, which fades out softly under them.
        .toolbarBackground(.hidden, for: .navigationBar)
        .softTopEdge()
        .toolbar {
            // Like a Messages conversation: the project's avatar with the thread's name under it.
            // Right after the back button, like Claude's, and only as wide as the space left
            // between it and the buttons on the right (long titles end in "…").
            ToolbarItem(placement: .topBarLeading) {
                let cwd = thread?.info.cwd ?? summary?.cwd ?? ""
                Button { showingDetails = true } label: {
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
                    .layoutPriority(1)
                    // Working: a small spinner in the pill (the buttons on the right stay put).
                    if running {
                        ProgressView().controlSize(.mini)
                    }
                }
                // The text itself gets the width limit (the toolbar would otherwise let it take
                // its full length and spill out of the pill), so long titles end in "…" inside.
                .modifier(CappedWidth(max: titleWidth - 19))
                .padding(.leading, 5)
                .padding(.trailing, 14)
                .padding(.vertical, 5)
                // A floating pill of its own, like Claude's, over the conversation.
                .floatingBackground(in: Capsule())
                .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(thread == nil)
                .accessibilityHint("Shows the thread’s details")
            }
            .hidingSharedBackground()
            // Like Claude's: working spinner, a new thread in this project, and more.
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button { showingChanges = true } label: {
                        Label("Changes", systemImage: "plus.forwardslash.minus")
                    }
                    .disabled(thread == nil)
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
        // The branch (GET /api/threads/:id/git): on opening, even while the agent works, and again
        // whenever a turn ends (it may have switched branches). The last one known shows at once.
        .task(id: "\(threadId)|\(thread?.info.status.isRunning == true)") {
            await model.refreshBranch(of: threadId)
        }
        .sheet(isPresented: $showingChanges) { ChangesView(threadId: threadId) }
        .sheet(isPresented: $showingDetails) {
            if let thread {
                ThreadDetailsSheet(thread: thread, branch: branchName) {
                    // After the details sheet has gone: one sheet at a time.
                    Task {
                        try? await Task.sleep(for: .milliseconds(350))
                        editingSettings = true
                    }
                }
            }
        }
        .sheet(isPresented: $editingSettings) {
            if let thread { ThreadSettingsSheet(thread: thread) }
        }
    }

    private let bottomId = "bottom"

    /// Puts the conversation at its end; it shows the moment it's there (the end check below),
    /// like T3 Code's feed, so a thread that's ready shows at once. Shown after a second at most.
    /// How far the conversation is from its true end, counting the space under the message box.
    nonisolated static func distanceFromEnd(_ geometry: ScrollGeometry) -> CGFloat {
        geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY
    }

    private func land() {
        guard !landed else { return }
        position.scrollTo(edge: .bottom)
        guard landing == nil else { return }
        landing = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            if !landed {
                position.scrollTo(edge: .bottom)
                landed = true
            }
        }
    }

    /// The screen minus the back button (~70 pt with margins) and the ⋯ ✎ group (~115 pt), plus
    /// the gap iOS wants between them. Leave too little and iOS hides ✎ (it collapses the right
    /// side to fit), so this errs on the roomy side.
    private var titleWidth: CGFloat {
        max(140, min(320, (width > 0 ? width : 390) - 232))
    }

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
        return model.branches[threadId]?.branch
    }

    /// Changes whenever something new appears at the bottom, to follow it.
    private var scrollKey: String {
        guard let thread else { return "" }
        let last = thread.messages.last
        return "\(thread.messages.count)-\(sending.count)-\(last?.text.count ?? 0)-\(last?.blocks?.count ?? 0)-\(thread.activities.count)-\(thread.info.approvals.count)"
    }

    /// Messages you just sent that the computer hasn't shown back yet (shown at once).
    private var sending: [Message] { model.outgoing[threadId] ?? [] }

    private func turns(of thread: ChatThread) -> [Turn] {
        Turn.build(messages: visibleMessages(thread) + sending, activities: thread.activities,
                   running: thread.info.status.isRunning || thread.info.status == .waiting || !sending.isEmpty,
                   completedAt: thread.info.completedAt, status: thread.info.status, todos: thread.info.todos)
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

/// Exactly min(natural width, `max`), whatever the parent offers: in a toolbar the text would
/// otherwise spill out of the pill (no offer) or stop short (too small an offer). Long text
/// truncates at `max`; short content keeps its natural width.
struct CappedWidth: ViewModifier {
    let max: CGFloat

    func body(content: Content) -> some View {
        CappedWidthLayout(max: max) { content }
    }
}

private struct CappedWidthLayout: Layout {
    let max: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        // Not the toolbar's offer: it offers leading items less than the real room between the
        // back button and the buttons on the right, which `max` already accounts for.
        let natural = child.sizeThatFits(.unspecified).width
        let width = Swift.min(natural, max)
        return child.sizeThatFits(ProposedViewSize(width: width, height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// The character celebrating once when a turn has just finished (4 seconds after it ended, like
/// the web app's Celebration), then gone.
struct Celebration: View {
    let provider: Provider
    let at: String
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false

    var body: some View {
        Group {
            if visible && Self.mascotsOn(model: model, reduceMotion: reduceMotion) {
                Mascot(provider: provider, mood: .celebrating, size: 34)
                    .padding(.vertical, -6)
                    .transition(.opacity)
            }
        }
        .task(id: at) {
            guard let ended = RelativeTime.parse(at) else { return }
            let left = 4 - Date().timeIntervalSince(ended)
            guard left > 0 else { visible = false; return }
            visible = true
            try? await Task.sleep(for: .seconds(left))
            withAnimation(.easeOut(duration: 0.3)) { visible = false }
        }
    }
}
