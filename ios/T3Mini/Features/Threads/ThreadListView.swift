import SwiftUI

/// The thread list, like the web app's sidebar: the same rows (project and avatar over the title,
/// the time or status word, the agent's logo), the same Group by as the computer (by project, by
/// date, or not grouped), and a project filter.
struct ThreadListView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [String] = []
    @State private var search = ""
    @State private var composing = false
    @State private var showingSettings = false
    /// One project's threads only (nil: all projects), like the sidebar's filter.
    @State private var onlyProject: String?
    @State private var collapsed: Set<String> = []
    // Press-and-hold actions.
    @State private var renaming: ThreadSummary?
    @State private var newTitle = ""
    @State private var deleting: ThreadSummary?
    @State private var problem: String?

    var body: some View {
        NavigationStack(path: $path) {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                List {
                    ForEach(sections(now: context.date)) { section in
                        if let header = section.header {
                            Section {
                                if !collapsed.contains(section.id) { rows(section, now: context.date) }
                            } header: {
                                SectionHeader(header: header, collapsed: collapsed.contains(section.id)) {
                                    withAnimation(.snappy) {
                                        if collapsed.contains(section.id) { collapsed.remove(section.id) } else { collapsed.insert(section.id) }
                                    }
                                }
                            }
                        } else {
                            rows(section, now: context.date)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .appScreen()
            }
            .overlay {
                if model.threads.isEmpty {
                    if case .offline(let reason) = model.link {
                        ContentUnavailableView("Can’t reach your computer", systemImage: "wifi.slash", description: Text(reason))
                    } else if model.link == .connecting {
                        ProgressView("Connecting…")
                    } else {
                        ContentUnavailableView("No threads yet", systemImage: "bubble.left.and.bubble.right",
                                               description: Text("Tap the pencil to start one."))
                    }
                } else if filtered.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
            .refreshable { await model.refresh() }
            .searchable(text: $search, prompt: "Search")
            .navigationTitle("Threads")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
                ToolbarItem(placement: .principal) { ConnectionBadge() }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    projectFilter
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New thread")
                        .disabled(model.projects.isEmpty && model.threads.isEmpty)
                }
            }
            .navigationDestination(for: String.self) { id in
                ChatView(threadId: id)
            }
            .sheet(isPresented: $composing) {
                NewThreadSheet { id in path.append(id) }
            }
            .sheet(isPresented: $showingSettings) { SettingsSheet() }
            .alert("Rename thread", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Title", text: $newTitle)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard let thread = renaming, !title.isEmpty, title != thread.title else { return }
                    attempt { try await model.rename(thread.id, to: String(title.prefix(120))) }
                }
            }
            // A centered alert on the screen, not a dialog on the row: the list redraws on live
            // updates (about once a second while agents work), which closed a row's dialog by
            // itself. It names the thread, so it's clear which one it's about.
            .alert("Delete “\(deleting?.title ?? "this thread")”?",
                   isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                   presenting: deleting) { thread in
                Button("Delete", role: .destructive) {
                    attempt {
                        try await model.deleteThread(thread.id)
                        path.removeAll { $0 == thread.id }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("The thread and its conversation are removed from your computer. Files the agent changed stay as they are.")
            }
            .overlay(alignment: .bottom) { undoBar }
            .onChange(of: model.deleteProblem) { _, message in
                if let message { problem = message; model.deleteProblem = nil }
            }
            .alert("Couldn’t do that", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(problem ?? "") }
        }
        .onChange(of: path) { _, path in model.open(path.last) }
        // A tapped notification (or the debug launch) opens its thread: on top of whatever was
        // open, with any sheet closed so the thread is what you see.
        .onChange(of: model.pendingOpen, initial: true) { _, id in
            guard let id else { return }
            model.pendingOpen = nil
            composing = false
            showingSettings = false
            if path != [id] { path = [id] }
        }
        // A sub-agent's or helper's thread, opened from a card: on top of the current thread.
        .onChange(of: model.pushThread) { _, id in
            guard let id else { return }
            model.pushThread = nil
            if path.last != id { path.append(id) }
        }
        #if DEBUG
        // Debug builds only: T3MINI_REOPEN=<thread id> opens it, goes back, and opens it again
        // (for checking where a reopened thread lands, in the simulator).
        .task {
            if ProcessInfo.processInfo.environment["T3MINI_PREVIEW_BANNER"] != nil {
                try? await Task.sleep(for: .seconds(5))
                model.previewBanner()
            }
            if ProcessInfo.processInfo.environment["T3MINI_PREVIEW_UNDO"] != nil {
                try? await Task.sleep(for: .seconds(4))
                if let thread = model.listedThreads.first { model.previewUndo(thread) }
            }
            guard let id = ProcessInfo.processInfo.environment["T3MINI_REOPEN"] else { return }
            try? await Task.sleep(for: .seconds(4))
            path = [id]
            try? await Task.sleep(for: .seconds(4))
            path = []
            try? await Task.sleep(for: .seconds(2))
            path = [id]
        }
        #endif
    }

    /// All projects, or one: the filter menu in the toolbar.
    private var projectFilter: some View {
        Menu {
            Picker("Show threads from", selection: $onlyProject) {
                Text("All projects").tag(String?.none)
                ForEach(model.projects.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }) { project in
                    Text(project.displayName).tag(Optional(project.path))
                }
            }
        } label: {
            Image(systemName: onlyProject == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel(onlyProject.map { "Showing \(model.projectName(for: $0))" } ?? "All projects")
    }

    private var filtered: [ThreadSummary] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard onlyProject != nil || !query.isEmpty else { return model.listedThreads }
        return model.listedThreads.filter { thread in
            (onlyProject == nil || thread.cwd == onlyProject)
                && (query.isEmpty || thread.title.localizedCaseInsensitiveContains(query)
                    || model.projectName(for: thread.cwd).localizedCaseInsensitiveContains(query))
        }
    }

    private func sections(now: Date) -> [ThreadSection] {
        // One project picked: grouping by it would be a single header, so list it plainly.
        let groupBy = onlyProject != nil ? "none" : (model.ui?.groupBy ?? "project")
        return ThreadSection.group(filtered, by: groupBy, projects: model.projects, now: now)
    }

    @ViewBuilder private func rows(_ section: ThreadSection, now: Date) -> some View {
        // Lookups the model keeps up to date (not rebuilt on every redraw). Helper threads aren't
        // listed: they're in their lead's details (tap its title pill) and report in its chat.
        let projects = model.projectsByPath
        ForEach(section.threads) { thread in
            row(thread, project: projects[thread.cwd], showProject: section.showProject, nested: false, now: now)
        }
    }

    private func row(_ thread: ThreadSummary, project: ProjectSummary?, showProject: Bool, nested: Bool, now: Date) -> some View {
        // A button with its own pressed look (a soft rounded highlight) instead of the list's
        // full-width grey flash.
        Button { path.append(thread.id) } label: {
            HStack(alignment: .center, spacing: 8) {
                if nested {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .accessibilityLabel("Helper thread")
                }
                ThreadRow(thread: thread,
                          projectName: project?.displayName ?? (thread.cwd as NSString).lastPathComponent,
                          project: project, avatar: project.flatMap { model.cachedAvatar($0) },
                          showProject: showProject, now: now)
                    .equatable()
            }
            .padding(.leading, nested ? 26 : 12)
            .padding(.trailing, 12)
            .padding(.vertical, nested ? 9 : 12)
            .contentShape(.rect(cornerRadius: 16))
            // Pressed and held: the row lifts as a rounded card.
            .contentShape(.contextMenuPreview, .rect(cornerRadius: 16))
        }
        .buttonStyle(ThreadRowButtonStyle())
        .contextMenu { actions(for: thread) }
        // Swipe left, like Mail: Delete (asks first; while the agent works it's Stop instead) and
        // Mark as read. No full-swipe, so a long swipe never deletes by accident.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if thread.status.isRunning || thread.status == .waiting {
                Button { attempt { try await model.stop(thread.id) } } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .tint(.orange)
            } else {
                // Gone at once, with Undo for a few seconds (no confirmation that snaps the row back).
                Button(role: .destructive) {
                    withAnimation(.snappy) { model.deleteWithUndo(thread) }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .tint(.red)
            }
            if thread.unread == true {
                Button { Task { await model.markRead(thread.id) } } label: {
                    Label("Read", systemImage: "envelope.open")
                }
                .tint(.blue)
            }
        }
        // No dividers: the rows are told apart by their space and avatars.
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 1, leading: 8, bottom: 1, trailing: 6))
    }
}

extension ThreadListView {
    /// "Deleted “…” · Undo", above the search bar, while a swiped-away thread can still come back.
    @ViewBuilder var undoBar: some View {
        if let thread = model.undoable {
            HStack(spacing: 12) {
                Image(systemName: "trash").foregroundStyle(.secondary)
                Text("Deleted “\(thread.title)”").font(.subheadline).lineLimit(1)
                Spacer(minLength: 8)
                Button("Undo") { withAnimation(.snappy) { model.undoDelete() } }
                    .font(.subheadline.weight(.semibold))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .floatingBackground(in: Capsule())
            .padding(.horizontal, 16)
            // The list's safe area already ends above the floating search bar: a small gap keeps
            // the bar right on top of it.
            .padding(.bottom, 10)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .animation(.snappy, value: model.undoable?.id)
        }
    }

    /// Press and hold a thread: the everyday actions, like the web sidebar's right-click menu.
    @ViewBuilder func actions(for thread: ThreadSummary) -> some View {
        Button { Task { await newThread(like: thread) } } label: {
            Label("New thread in this project", systemImage: "square.and.pencil")
        }
        Divider()
        Button {
            newTitle = thread.title
            renaming = thread
        } label: { Label("Rename…", systemImage: "pencil") }
        Button { attempt { try await model.regenerateTitle(thread.id) } } label: {
            Label("Regenerate title", systemImage: "sparkles")
        }
        Button { UIPasteboard.general.string = thread.cwd } label: {
            Label("Copy project path", systemImage: "doc.on.doc")
        }
        if thread.unread == true {
            Button { Task { await model.markRead(thread.id) } } label: {
                Label("Mark as read", systemImage: "envelope.open")
            }
        }
        if thread.status.isRunning || thread.status == .waiting {
            Divider()
            Button(role: .destructive) { attempt { try await model.stop(thread.id) } } label: {
                Label("Stop", systemImage: "stop.circle")
            }
        }
        Divider()
        Button(role: .destructive) { deleting = thread } label: { Label("Delete…", systemImage: "trash") }
            .disabled(thread.status.isRunning || thread.status == .waiting)
    }

    func attempt(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action() } catch { problem = error.localizedDescription }
        }
    }

    /// Same project and agent, with that agent's last-used settings; opens it.
    private func newThread(like thread: ThreadSummary) async {
        do {
            if let id = try await model.createThread(project: model.project(at: thread.cwd),
                                                     choice: model.defaultChoice(for: thread.provider)) {
                path = [id]
            }
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// The thread row's pressed look: a soft rounded highlight inset from the edges and a slight
/// press-in, instead of the list's full-width grey flash.
struct ThreadRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Color(.secondarySystemFill).opacity(configuration.isPressed ? 1 : 0),
                        in: .rect(cornerRadius: 16))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: configuration.isPressed ? 0.08 : 0.2), value: configuration.isPressed)
    }
}

/// A group in the list: a project, a date range, or (not grouped) everything with no header.
struct ThreadSection: Identifiable {
    enum Header { case project(ProjectSummary?, name: String), date(String) }
    let id: String
    let header: Header?
    let threads: [ThreadSummary]
    /// Rows show their project over the title unless the section is the project.
    var showProject: Bool {
        if case .project = header { return false }
        return true
    }

    /// Like the web sidebar: by project (in the order they were added, so they don't jump around
    /// with activity), by date (Today, Yesterday, This week, Older), or one list. Threads are
    /// newest first inside each group.
    static func group(_ threads: [ThreadSummary], by groupBy: String, projects: [ProjectSummary],
                      now: Date = Date(), calendar: Calendar = .current) -> [ThreadSection] {
        switch groupBy {
        case "project":
            let byPath = Dictionary(grouping: threads, by: \.cwd)
            let byProject = Dictionary(projects.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
            let order = projects.sorted { ($0.addedAt ?? "") < ($1.addedAt ?? "") }.map(\.path)
            let known = Set(order)
            let paths = order.filter { byPath[$0] != nil } + byPath.keys.filter { !known.contains($0) }.sorted()
            return paths.map { path in
                let project = byProject[path]
                return ThreadSection(id: "p:" + path,
                                     header: .project(project, name: project?.displayName ?? (path as NSString).lastPathComponent),
                                     threads: byPath[path] ?? [])
            }
        case "date":
            let today = calendar.startOfDay(for: now)
            let starts: [(String, Date)] = [
                ("Today", today),
                ("Yesterday", calendar.date(byAdding: .day, value: -1, to: today)!),
                ("This week", calendar.date(byAdding: .day, value: -6, to: today)!),
                ("Older", .distantPast),
            ]
            var buckets = Array(repeating: [ThreadSummary](), count: starts.count)
            for thread in threads {
                let date = RelativeTime.parse(thread.lastMessageAt ?? thread.updatedAt) ?? .distantPast
                let index = starts.firstIndex { date >= $0.1 } ?? starts.count - 1
                buckets[index].append(thread)
            }
            return starts.indices.compactMap { index in
                buckets[index].isEmpty ? nil
                    : ThreadSection(id: "d:" + starts[index].0, header: .date(starts[index].0), threads: buckets[index])
            }
        default:
            return [ThreadSection(id: "all", header: nil, threads: threads)]
        }
    }
}

/// A group's header: the project (avatar and name) or the date range. Tap to fold it.
private struct SectionHeader: View {
    let header: ThreadSection.Header
    let collapsed: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 8) {
                switch header {
                case .project(let project, let name):
                    ProjectAvatar(name: name, project: project, size: 20, square: true)
                    Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                case .date(let label):
                    Text(label).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(collapsed ? -90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
    }
}

/// One thread, like a web sidebar row but with room to read: the project (small avatar and name)
/// over the title, the status or time on the right, and the agent's logo under it. Bold while it
/// has news you haven't seen.
struct ThreadRow: View, Equatable {
    let thread: ThreadSummary
    let projectName: String
    var project: ProjectSummary?
    var avatar: UIImage?
    var showProject = true
    var now = Date()

    private var unread: Bool { thread.unread == true }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            // The project's avatar in its own column, like Messages and Mail, so the project
            // name and the title line up on one left edge next to it.
            if showProject {
                ProjectAvatar(name: projectName, project: project, size: 38, square: true, cached: avatar)
            }
            // Refined type: a calm, slightly smaller project line close to its title, and a
            // medium-weight title (semibold when unread), like a well-set mail list.
            VStack(alignment: .leading, spacing: 3) {
                if showProject {
                    Text(projectName)
                        .font(.footnote)
                        .tracking(0.1)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(thread.title)
                    .font(.callout.weight(unread ? .semibold : .medium))
                    .tracking(-0.1)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .lineSpacing(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 8) {
                ThreadStatusLabel(thread: thread, now: now)
                AgentLogo(provider: thread.provider, size: 15)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // Only redraw a row when what it shows changed (live updates resend the whole list).
    nonisolated static func == (a: ThreadRow, b: ThreadRow) -> Bool {
        a.thread == b.thread && a.projectName == b.projectName && a.project == b.project
            && a.showProject == b.showProject && (a.avatar == nil) == (b.avatar == nil)
            && ThreadStatusLabel.label(a.thread, now: a.now) == ThreadStatusLabel.label(b.thread, now: b.now)
    }
}

/// The right-hand label: a clear "Working" pill while the agent works; Question or Approval while
/// it waits for you; Done (green) or Failed (red) for a turn that ended while you weren't looking;
/// else how long ago it changed ("now", "5m", "3h", "2d", "Nov 5"). Same words as the web sidebar.
struct ThreadStatusLabel: View {
    let thread: ThreadSummary
    let now: Date

    var body: some View {
        if thread.status.isRunning {
            HStack(spacing: 5) {
                ProgressView()
                    .controlSize(.mini)
                    .tint(.white)
                Text("Working")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.accentColor, in: .capsule)
            .accessibilityLabel("Working")
        } else {
            let label = Self.label(thread, now: now)
            let isTime = label == Self.time(thread, now: now)
            Text(label)
                .font(isTime ? .caption : .caption.weight(.semibold))
                .foregroundStyle(color)
                .monospacedDigit()
                .padding(.horizontal, isTime ? 0 : 8)
                .padding(.vertical, isTime ? 0 : 4)
                .background(isTime ? Color.clear : color.opacity(0.15), in: .capsule)
        }
    }

    private var color: Color {
        switch thread.status {
        case .waiting: .orange
        case .failed: .red
        case .completed where thread.unread == true: .green
        default: .secondary
        }
    }
    nonisolated static func label(_ thread: ThreadSummary, now: Date) -> String {
        if thread.status == .waiting { return thread.waitingFor == "question" ? "Question" : "Approval" }
        if thread.unread == true && thread.status == .completed { return "Done" }
        if thread.unread == true && thread.status == .failed { return "Failed" }
        return time(thread, now: now)
    }

    nonisolated static func time(_ thread: ThreadSummary, now: Date) -> String {
        guard let date = RelativeTime.parse(thread.updatedAt) else { return "" }
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "\(minutes)m" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "\(hours)h" }
        let days = max(1, Int(seconds / 86_400))
        if days < 7 { return "\(days)d" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

/// Claude's or Codex's logo (the web app's own artwork, as vector assets).
struct AgentLogo: View {
    let provider: Provider
    var size: CGFloat = 14

    var body: some View {
        Image(provider == .claude ? "Claude" : "Codex")
            .resizable()
            .renderingMode(provider == .claude ? .original : .template)
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(.secondary)
            .accessibilityLabel(provider == .claude ? "Claude Code" : "Codex")
    }
}

/// Live / connecting / offline, under the title.
struct ConnectionBadge: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.link {
        case .live:
            EmptyView()
        case .connecting:
            Label("Connecting…", systemImage: "arrow.triangle.2.circlepath")
                .font(.caption).foregroundStyle(.secondary)
        case .offline:
            Label("Offline", systemImage: "wifi.slash")
                .font(.caption).foregroundStyle(.orange)
        }
    }
}
