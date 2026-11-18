import Foundation
import UIKit
import Observation

/// Everything the screens show, kept up to date by one live-update stream to the paired computer.
@MainActor
@Observable
final class AppModel {
    enum LinkState: Equatable {
        case connecting
        case live
        /// Couldn't reach the computer; retrying on its own.
        case offline(String)
    }

    private(set) var connection: Connection?
    private(set) var threads: [ThreadSummary] = []
    private(set) var projects: [ProjectSummary] = []
    private(set) var ui: UiSettings?
    private(set) var link: LinkState = .connecting
    /// The thread on screen, whole, kept current by patches.
    private(set) var openThread: ChatThread? {
        didSet { if let openThread { remember(openThread) } }
    }
    private(set) var openThreadId: String?
    /// The session ended (expired or removed on the computer): back to pairing.
    private(set) var unpairedNotice: String?

    /// A thread to open from outside the list (debug launch), picked up by the list's navigation.
    var pendingOpen: String?

    private var client: APIClient?
    private var streamTask: Task<Void, Never>?

    init(connection: Connection? = Keychain.load()) {
        images.totalCostLimit = 80 * 1024 * 1024
        if let connection { use(connection) }
    }

    var isPaired: Bool { connection != nil }

    /// Threads for the list: newest activity first, sub-threads hidden like the sidebar.
    var listedThreads: [ThreadSummary] {
        threads
            .filter { $0.parentId == nil }
            .sorted { ($0.lastMessageAt ?? $0.updatedAt) > ($1.lastMessageAt ?? $1.updatedAt) }
    }

    func project(for thread: ThreadSummary) -> ProjectSummary? {
        projects.first { $0.path == thread.cwd }
    }

    func projectName(for cwd: String) -> String {
        projects.first { $0.path == cwd }?.displayName ?? (cwd as NSString).lastPathComponent
    }

    // MARK: Images

    /// Images by id, kept while the app runs (ids never change content: they're generated per upload).
    private let images = NSCache<NSString, NSData>()

    func imageData(_ id: String) async throws -> Data {
        try await cachedImage("upload:" + id) { try await $0.image(id) }
    }

    /// Avatars already decoded, by project and choice, so a row scrolling back into view shows its
    /// image at once instead of its letter and a fresh decode.
    private let avatarImages = NSCache<NSString, UIImage>()

    func avatarKey(_ project: ProjectSummary) -> String {
        [project.path, project.avatar ?? "", project.image ?? "", project.icon == true ? "1" : "0",
         ui?.projectIcons == false ? "off" : "on"].joined(separator: "|")
    }

    func cachedAvatar(_ project: ProjectSummary) -> UIImage? {
        avatarImages.object(forKey: avatarKey(project) as NSString)
    }

    func loadAvatar(_ project: ProjectSummary) async -> UIImage? {
        let key = avatarKey(project) as NSString
        if let image = avatarImages.object(forKey: key) { return image }
        guard let data = await projectAvatar(project),
              let image = await Task.detached(operation: { UIImage(data: data)?.preparingForDisplay() }).value
        else { return nil }
        avatarImages.setObject(image, forKey: key)
        return image
    }

    /// The image a project's avatar shows, like the web app: an image chosen for it, else its own
    /// icon (unless icons are off on the computer, or it's set to its letter), else nil (letter).
    func projectAvatar(_ project: ProjectSummary) async -> Data? {
        if project.avatar == "image", let image = project.image {
            return try? await imageData(image)
        }
        guard project.avatar != "letter", project.icon == true, ui?.projectIcons != false else { return nil }
        return try? await cachedImage("icon:" + project.path) { try await $0.projectIcon(project.path) }
    }

    private func cachedImage(_ key: String, load: (APIClient) async throws -> Data) async throws -> Data {
        if let cached = images.object(forKey: key as NSString) { return cached as Data }
        guard let client else { throw APIError.unpaired }
        let data = try await load(client)
        images.setObject(data as NSData, forKey: key as NSString, cost: data.count)
        return data
    }

    /// Built pages by id and look, kept while the app runs (a page's HTML never changes).
    private var pages: [String: String] = [:]

    func htmlPage(_ id: String, dark: Bool, inline: Bool, libraries: [String]) async throws -> String {
        let key = "\(id)|\(dark)|\(inline)"
        if let page = pages[key] { return page }
        guard let client else { throw APIError.unpaired }
        let page = try await client.htmlPage(id, dark: dark, inline: inline, libraries: libraries)
        if pages.count > 40 { pages.removeAll() }
        pages[key] = page
        return page
    }

    func project(at path: String) -> ProjectSummary? {
        projects.first { $0.path == path }
    }

    // MARK: Opened threads

    /// Threads opened before, kept so going back into one shows it at once (like Messages), then
    /// live updates bring it up to date. The most recent 30.
    private var opened: [String: ChatThread] = [:]
    private var openedOrder: [String] = []

    private func remember(_ thread: ChatThread) {
        opened[thread.id] = thread
        openedOrder.removeAll { $0 == thread.id }
        openedOrder.append(thread.id)
        while openedOrder.count > 30 { opened[openedOrder.removeFirst()] = nil }
    }

    // MARK: Pairing

    func pair(with text: String) async throws {
        let link = try PairingLink(text)
        let connection = try await APIClient.pair(link)
        guard Keychain.save(connection) else {
            throw APIError.server(0, "Couldn’t save the connection in the Keychain.")
        }
        unpairedNotice = nil
        use(connection)
    }

    /// Forgets the computer on this phone. (It still lists this phone until it's removed there.)
    func disconnect() {
        Keychain.delete()
        stopStream()
        client = nil
        connection = nil
        threads = []
        projects = []
        openThread = nil
        openThreadId = nil
        opened = [:]
        openedOrder = []
        pages = [:]
        images.removeAllObjects()
        avatarImages.removeAllObjects()
    }

    private func use(_ connection: Connection) {
        self.connection = connection
        client = APIClient(connection: connection)
        restartStream()
    }

    private func sessionEnded() {
        disconnect()
        unpairedNotice = APIError.unpaired.errorDescription
    }

    // MARK: Threads

    func open(_ id: String?) {
        guard id != openThreadId else { return }
        openThreadId = id
        openThread = id.flatMap { opened[$0] }
        restartStream()
        if let id { Task { try? await client?.markRead(id) } }
    }

    func refresh() async {
        guard let client else { return }
        do {
            let bootstrap = try await client.bootstrap()
            if bootstrap.threads != threads { threads = bootstrap.threads }
            if bootstrap.projects != projects { projects = bootstrap.projects }
            if bootstrap.ui != ui { ui = bootstrap.ui }
            if let id = openThreadId { openThread = try await client.thread(id) }
        } catch APIError.unpaired {
            sessionEnded()
        } catch {
            link = .offline(error.localizedDescription)
        }
    }

    func send(_ text: String) async throws {
        guard let client, let id = openThreadId else { return }
        try await run { try await client.send(text, to: id) }
    }

    func stop() async throws {
        guard let client, let id = openThreadId else { return }
        try await run { try await client.stop(id) }
    }

    func answer(_ approval: Approval, allow: Bool, answers: [String: String]? = nil) async throws {
        guard let client, let id = openThreadId else { return }
        try await run { try await client.approve(id, approvalId: approval.id, allow: allow, answers: answers) }
    }

    /// Starts a thread with the agent defaults from the computer (the last ones used there).
    func createThread(provider: Provider, project: ProjectSummary?) async throws -> String? {
        guard let client else { return nil }
        let settings = ui?.agent?.settings?[provider.rawValue]
        var created: ChatThread?
        try await run { created = try await client.createThread(provider: provider, project: project, settings: settings) }
        return created?.id
    }

    var defaultProvider: Provider { ui?.agent?.provider ?? .claude }

    /// The project new threads start in: the one last used on the computer, else the most recent.
    var defaultProject: ProjectSummary? {
        if let cwd = ui?.agent?.cwd, let match = projects.first(where: { $0.path == cwd }) { return match }
        return projects.filter { $0.chats != true }.max { ($0.lastActiveAt ?? "") < ($1.lastActiveAt ?? "") }
    }

    private func run(_ action: () async throws -> Void) async throws {
        do {
            try await action()
        } catch APIError.unpaired {
            sessionEnded()
            throw APIError.unpaired
        }
    }

    // MARK: Live updates

    /// One stream at a time, for the open thread (or none). Reconnects with a growing wait.
    private func restartStream() {
        stopStream()
        guard let client else { return }
        let threadId = openThreadId
        streamTask = Task { [weak self] in
            var wait: UInt64 = 1
            while !Task.isCancelled {
                // Switching threads reconnects; keep showing "live" instead of flashing "connecting".
                if self?.link != .live { self?.link = .connecting }
                do {
                    for try await update in client.events(thread: threadId) {
                        guard let self else { return }
                        wait = 1
                        self.link = .live
                        await self.apply(update, threadId: threadId, client: client)
                    }
                } catch APIError.unpaired {
                    self?.sessionEnded()
                    return
                } catch {
                    if Task.isCancelled { return }
                    self?.link = .offline(error.localizedDescription)
                }
                if Task.isCancelled { return }
                try? await Task.sleep(nanoseconds: wait * 1_000_000_000)
                wait = min(wait * 2, 30)
            }
        }
    }

    private func stopStream() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func apply(_ update: LiveUpdate, threadId: String?, client: APIClient) async {
        // Only real changes: @Observable redraws whatever reads a property on every assignment, and
        // while an agent works the thread list arrives several times a second.
        if let threads = update.threads, threads != self.threads { self.threads = threads }
        if let projects = update.projects, projects != self.projects { self.projects = projects }
        if let ui = update.ui, ui != self.ui { self.ui = ui }
        guard threadId == openThreadId else { return }
        // It finished while you're looking at it: not unread.
        if let id = threadId, threads.first(where: { $0.id == id })?.unread == true {
            Task { try? await client.markRead(id) }
        }
        if let thread = update.thread { openThread = thread }
        if let patch = update.threadPatch {
            if let current = openThread, let next = patch.apply(to: current) {
                openThread = next
            } else if let id = threadId {
                // A gap or a mismatch: load it whole again.
                openThread = try? await client.thread(id)
            }
        }
    }
}
