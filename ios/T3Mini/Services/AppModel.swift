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
    private(set) var threads: [ThreadSummary] = [] {
        didSet { indexThreads() }
    }
    private(set) var projects: [ProjectSummary] = [] {
        didSet { projectsByPath = Dictionary(projects.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first }) }
    }
    /// Kept up to date with the lists above, so the thread list (redrawn on every live update,
    /// even mid-scroll) doesn't sort, search, or group again each time.
    private(set) var listedThreads: [ThreadSummary] = []
    /// Helper threads by their lead, newest first.
    private(set) var helpersByLead: [String: [ThreadSummary]] = [:]
    private(set) var projectsByPath: [String: ProjectSummary] = [:]

    // MARK: Swipe to delete, with Undo (like Mail and Gmail)

    /// Threads swiped away: hidden at once, deleted on the computer a few seconds later unless
    /// you tap Undo.
    private(set) var hiddenForUndo: Set<String> = []
    /// The latest one, for the Undo bar.
    private(set) var undoable: ThreadSummary?
    /// A delete the computer refused (the thread is back in the list).
    var deleteProblem: String?
    private var pendingDeletes: [String: Task<Void, Never>] = [:]

    func deleteWithUndo(_ thread: ThreadSummary) {
        hiddenForUndo.insert(thread.id)
        undoable = thread
        indexThreads()
        pendingDeletes[thread.id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard let self, !Task.isCancelled, self.hiddenForUndo.contains(thread.id) else { return }
            if self.undoable?.id == thread.id { self.undoable = nil }
            do {
                try await self.deleteThread(thread.id)
            } catch {
                self.deleteProblem = error.localizedDescription
            }
            self.hiddenForUndo.remove(thread.id)
            self.pendingDeletes[thread.id] = nil
            self.indexThreads()
        }
    }

    #if DEBUG
    /// Debug builds only: shows the Undo bar without deleting anything (T3MINI_PREVIEW_UNDO).
    func previewUndo(_ thread: ThreadSummary) { undoable = thread }
    #endif

    func undoDelete() {
        guard let thread = undoable else { return }
        pendingDeletes[thread.id]?.cancel()
        pendingDeletes[thread.id] = nil
        hiddenForUndo.remove(thread.id)
        undoable = nil
        indexThreads()
    }

    private func indexThreads() {
        let newest: (ThreadSummary, ThreadSummary) -> Bool = {
            ($0.lastMessageAt ?? $0.updatedAt) > ($1.lastMessageAt ?? $1.updatedAt)
        }
        listedThreads = threads.filter { $0.parentId == nil && !hiddenForUndo.contains($0.id) }.sorted(by: newest)
        helpersByLead = Dictionary(grouping: threads.filter { $0.parentId != nil }, by: { $0.parentId! })
            .mapValues { $0.sorted(by: newest) }
    }
    private(set) var ui: UiSettings?
    private(set) var link: LinkState = .connecting
    /// The thread on screen, whole, kept current by patches.
    private(set) var openThread: ChatThread? {
        didSet {
            if let openThread {
                remember(openThread)
                settleOutgoing(openThread)
            }
        }
    }
    /// Messages you just sent, shown at once (optimistic) until the computer's own copy arrives,
    /// by thread.
    private(set) var outgoing: [String: [Message]] = [:]
    private(set) var openThreadId: String?
    /// The session ended (expired or removed on the computer): back to pairing.
    private(set) var unpairedNotice: String?

    /// A thread to open from outside the list (debug launch), picked up by the list's navigation.
    var pendingOpen: String?
    /// A thread to open on top of the current one (a sub-agent's or helper's thread); back
    /// returns to where you were.
    var pushThread: String?
    /// Videos and sounds already downloaded this session, by id.
    private var mediaFiles: [String: URL] = [:]

    /// A video or sound as a local file AVPlayer can play: downloaded once with this phone's
    /// session (the player can't send it), kept in Caches for the session. Ids are the
    /// server's (a uuid and the file type), checked before use as a file name.
    func mediaFile(_ id: String) async throws -> URL {
        if let file = mediaFiles[id], FileManager.default.fileExists(atPath: file.path) { return file }
        guard let client else { throw APIError.unpaired }
        let ext = (id as NSString).pathExtension.lowercased()
        guard !ext.isEmpty, ext.count <= 5, ext.allSatisfy({ $0.isLetter || $0.isNumber }) else { throw APIError.badResponse }
        let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: "t3mini-media", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appending(path: DiskCache.hash(id) + "." + ext)
        if !FileManager.default.fileExists(atPath: target.path) {
            var temp: URL?
            try await run { temp = try await client.downloadMedia(id) }
            guard let temp else { throw APIError.badResponse }
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: temp, to: target)
        }
        mediaFiles[id] = target
        return target
    }

    private var client: APIClient?
    private var streamTask: Task<Void, Never>?

    init(connection: Connection? = Keychain.load()) {
        images.totalCostLimit = 80 * 1024 * 1024
        if let connection { use(connection) }
    }

    var isPaired: Bool { connection != nil }

    /// Threads for the list: newest activity first, sub-threads hidden like the sidebar.

    func project(for thread: ThreadSummary) -> ProjectSummary? {
        projects.first { $0.path == thread.cwd }
    }

    func projectName(for cwd: String) -> String {
        projectsByPath[cwd]?.displayName ?? (cwd as NSString).lastPathComponent
    }

    // MARK: Images

    /// Images by id, kept while the app runs (ids never change content: they're generated per upload).
    private let images = NSCache<NSString, NSData>()
    /// The same on disk, per computer (DiskCache), so they outlive the app being closed.
    private var disk: DiskCache?
    /// Icons checked against the computer since launch (stale-while-revalidate: the saved copy
    /// shows at once, then it's checked once in the background).
    private var revalidated: Set<String> = []
    /// Bumped when a project's icon changed on the computer, so avatars redraw.
    private(set) var avatarRevision = 0

    func imageData(_ id: String) async throws -> Data {
        try await cachedImage("upload:" + id) { try await $0.image(id) }
    }

    /// Images already decoded (shrunk for the conversation, or full size for the viewer), so a
    /// thread you come back to shows its pictures at once, at their size, without decoding again.
    private let decodedImages: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 160 * 1024 * 1024
        return cache
    }()

    private func decodedKey(_ id: String, _ maxPixel: Int?) -> NSString { "\(id)|\(maxPixel ?? 0)" as NSString }

    func cachedDecodedImage(_ id: String, maxPixel: Int?) -> UIImage? {
        decodedImages.object(forKey: decodedKey(id, maxPixel))
    }

    func decodedImage(_ id: String, maxPixel: Int?) async throws -> UIImage? {
        let key = decodedKey(id, maxPixel)
        if let hit = decodedImages.object(forKey: key) { return hit }
        let data = try await imageData(id)
        let image = await Task.detached(priority: .userInitiated) { ImageDecode.decode(data, maxPixel: maxPixel) }.value
        if let image { decodedImages.setObject(image, forKey: key, cost: ImageDecode.cost(image)) }
        return image
    }

    /// Avatars already decoded, by project and choice, so a row scrolling back into view shows its
    /// image at once instead of its letter and a fresh decode.
    private let avatarImages = NSCache<NSString, UIImage>()

    func avatarKey(_ project: ProjectSummary) -> String {
        [project.path, project.avatar ?? "", project.image ?? "", project.icon == true ? "1" : "0",
         ui?.projectIcons == false ? "off" : "on"].joined(separator: "|")
    }

    /// Decoded already, or saved on this phone: shown at once (icons are small, so this reads and
    /// decodes right away instead of showing the letter first).
    func cachedAvatar(_ project: ProjectSummary) -> UIImage? {
        let key = avatarKey(project) as NSString
        if let image = avatarImages.object(forKey: key) { return image }
        guard let dataKey = avatarDataKey(project), let data = images.object(forKey: dataKey as NSString) as Data? ?? disk?.read(dataKey),
              let image = ImageDecode.decode(data, maxPixel: Self.avatarPixels)
        else { return nil }
        images.setObject(data as NSData, forKey: dataKey as NSString, cost: data.count)
        avatarImages.setObject(image, forKey: key)
        return image
    }

    func loadAvatar(_ project: ProjectSummary) async -> UIImage? {
        let key = avatarKey(project) as NSString
        if let image = avatarImages.object(forKey: key) { return image }
        guard let data = await projectAvatar(project),
              let image = await Task.detached(operation: { ImageDecode.decode(data, maxPixel: Self.avatarPixels) }).value
        else { return nil }
        avatarImages.setObject(image, forKey: key)
        return image
    }

    /// Avatars are at most ~48 pt: decoded small.
    nonisolated static let avatarPixels = 192

    /// Where a project's avatar image comes from (cache key), or nil for its letter.
    private func avatarDataKey(_ project: ProjectSummary) -> String? {
        if project.avatar == "image", let image = project.image { return "upload:" + image }
        guard project.avatar != "letter", project.icon == true, ui?.projectIcons != false else { return nil }
        return "icon:" + project.path
    }

    /// The image a project's avatar shows, like the web app: an image chosen for it, else its own
    /// icon (unless icons are off on the computer, or it's set to its letter), else nil (letter).
    func projectAvatar(_ project: ProjectSummary) async -> Data? {
        if project.avatar == "image", let image = project.image {
            guard let data = try? await imageData(image) else { return nil }
            return await SVGIcon.rasterizeIfNeeded(data)
        }
        guard project.avatar != "letter", project.icon == true, ui?.projectIcons != false else { return nil }
        let path = project.path
        // SVG icons are drawn into a PNG once (iOS can't decode SVG); the PNG is what's saved.
        guard let data = try? await cachedImage("icon:" + path, revalidate: true, load: { client in
            await SVGIcon.rasterizeIfNeeded(try await client.projectIcon(path))
        }) else { return nil }
        // A copy saved before this change may still be SVG.
        return await SVGIcon.rasterizeIfNeeded(data)
    }

    /// Memory, then this phone's disk, then the computer. Uploads never change, so a saved copy is
    /// final. Icons can (`revalidate`): the saved copy is used at once and checked against the
    /// computer once per launch in the background; if it changed, avatars redraw with the new one.
    private func cachedImage(_ key: String, revalidate: Bool = false,
                             load: @escaping (APIClient) async throws -> Data) async throws -> Data {
        if let cached = images.object(forKey: key as NSString) as Data? {
            if revalidate { refreshInBackground(key, load: load, current: cached) }
            return cached
        }
        let disk = disk
        if let saved = await Task.detached(operation: { disk?.read(key) }).value {
            images.setObject(saved as NSData, forKey: key as NSString, cost: saved.count)
            if revalidate { refreshInBackground(key, load: load, current: saved) }
            return saved
        }
        guard let client else { throw APIError.unpaired }
        let data = try await load(client)
        revalidated.insert(key)
        store(key, data)
        return data
    }

    private func store(_ key: String, _ data: Data) {
        images.setObject(data as NSData, forKey: key as NSString, cost: data.count)
        let disk = disk
        Task.detached(priority: .utility) { disk?.write(key, data) }
    }

    private func refreshInBackground(_ key: String, load: @escaping (APIClient) async throws -> Data, current: Data) {
        guard let client, revalidated.insert(key).inserted else { return }
        Task {
            guard let fresh = try? await load(client), fresh != current else { return }
            store(key, fresh)
            avatarImages.removeAllObjects()
            avatarRevision += 1
        }
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
        projectsByPath[path]
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

    // MARK: Push notifications (Services/Notifications.swift)

    enum PushState: Equatable {
        case unknown, off, on
        /// Allowed on the phone, but the computer has no Apple push key yet.
        case notSetUp
        /// Turned off for t3 mini in iOS Settings.
        case denied
    }
    private(set) var push: PushState = .unknown
    private(set) var pushProblem: String?

    private func startNotifications() {
        let notifications = Notifications.shared
        notifications.onToken = { [weak self] token in
            Task { await self?.registerPush(token: token) }
        }
        notifications.onOpenThread = { [weak self] id in
            guard let self, self.isPaired else { return }
            self.pendingOpen = id
        }
        notifications.visibleThread = { [weak self] in self?.openThreadId }
        // Live Activities: their push tokens go to the computer, which keeps them current.
        LiveActivities.shared.register = { [weak self] token, thread in
            guard let client = self?.client else { return }
            try? await client.registerActivity(token: token, thread: thread, environment: Notifications.environment,
                                               topic: Bundle.main.bundleIdentifier ?? "")
        }
        LiveActivities.shared.resume()
        Task {
            if await notifications.authorization == .denied { push = .denied }
            await notifications.refresh()
        }
    }

    private func registerPush(token: String) async {
        guard let client else { return }
        do {
            // The key titles are sealed with (only this phone and the computer have it).
            let key = PushKey.loadOrCreate().map(PushKey.base64)
            try await client.registerPush(token: token, environment: Notifications.environment,
                                          topic: Bundle.main.bundleIdentifier ?? "", key: key)
            let status = try await client.pushStatus(token: token)
            push = status.configured ? .on : .notSetUp
            pushProblem = nil
        } catch {
            pushProblem = error.localizedDescription
        }
    }

    /// The Settings switch: asks iOS (once), then registers with Apple and the computer.
    func enablePush() async {
        pushProblem = nil
        if await Notifications.shared.enable() {
            if let token = Notifications.shared.token { await registerPush(token: token) }
            // Otherwise the token arrives in a moment and registerPush runs then.
        } else {
            push = .denied
        }
    }

    func disablePush() async {
        if let client, let token = Notifications.shared.token { try? await client.unregisterPush(token: token) }
        push = .off
    }

    func testPush() async {
        guard let client, let token = Notifications.shared.token else {
            pushProblem = "Turn notifications on first."
            return
        }
        do {
            try await client.testPush(token: token)
            pushProblem = nil
        } catch {
            pushProblem = error.localizedDescription
        }
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
        // Stop this phone's notifications on the computer too (best effort).
        if let client, let token = Notifications.shared.token {
            Task { try? await client.unregisterPush(token: token) }
        }
        push = .off
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
        // Unpaired: this computer's saved pictures go too.
        disk?.removeAll()
        disk = nil
        revalidated = []
    }

    private func use(_ connection: Connection) {
        self.connection = connection
        client = APIClient(connection: connection)
        let cache = DiskCache(scope: connection.server.absoluteString)
        disk = cache
        Task.detached(priority: .background) { cache.trim() }
        restartStream()
        startNotifications()
        // The bootstrap's extras (dictation available) aren't in live updates.
        Task { await refresh() }
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
            if bootstrap.threads != threads {
                announceFinished(bootstrap.threads)
                threads = bootstrap.threads
                LiveActivities.shared.sync(threads)
            }
            if bootstrap.projects != projects { projects = bootstrap.projects }
            if bootstrap.ui != ui { ui = bootstrap.ui }
            if (bootstrap.dictation ?? false) != dictationAvailable { dictationAvailable = bootstrap.dictation ?? false }
            if let id = openThreadId { openThread = try await client.thread(id) }
        } catch APIError.unpaired {
            sessionEnded()
        } catch {
            link = .offline(error.localizedDescription)
        }
    }

    func send(_ text: String, attachments: [Attachment] = []) async throws {
        guard let client, let id = openThreadId else { return }
        // In the conversation right away; the computer's copy replaces it when it arrives.
        let local = Message(id: "local-" + UUID().uuidString, role: .user, text: text,
                            createdAt: Self.isoNow(), attachments: attachments.isEmpty ? nil : attachments)
        outgoing[id, default: []].append(local)
        do {
            try await run { try await client.send(text, attachments: attachments, to: id) }
        } catch {
            outgoing[id]?.removeAll { $0.id == local.id }
            throw error
        }
        if let openThread, openThread.id == id { settleOutgoing(openThread) }
        // On the lock screen while the agent works on it.
        let info = openThread?.id == id ? openThread?.info : nil
        let summary = threads.first { $0.id == id }
        LiveActivities.shared.start(threadId: id, title: info?.title ?? summary?.title ?? "Thread",
                                    project: projectName(for: info?.cwd ?? summary?.cwd ?? ""),
                                    provider: info?.provider ?? summary?.provider ?? .claude)
    }

    /// Drops the messages you sent once the computer's copy is in the thread (a message of yours
    /// with the same text, from around then), or after a minute at most.
    private func settleOutgoing(_ thread: ChatThread) {
        guard let pending = outgoing[thread.id], !pending.isEmpty else { return }
        let mine = thread.messages.filter { $0.role == .user && $0.report == nil }
        let now = Date()
        let left = pending.filter { local in
            guard let sent = RelativeTime.parse(local.createdAt) else { return false }
            if now.timeIntervalSince(sent) > 60 { return false }
            return !mine.contains { real in
                real.text == local.text && (RelativeTime.parse(real.createdAt).map { $0 > sent.addingTimeInterval(-30) } ?? false)
            }
        }
        if left.count != pending.count { outgoing[thread.id] = left.isEmpty ? nil : left }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    static func isoNow() -> String { isoFormatter.string(from: Date()) }

    func uploadFile(_ data: Data, name: String, mimeType: String) async throws -> String {
        guard let client else { throw APIError.unpaired }
        var path = ""
        try await run { path = try await client.uploadFile(data, name: name, mimeType: mimeType) }
        return path
    }

    func uploadImage(_ data: Data, name: String, mimeType: String) async throws -> Attachment {
        guard let client else { throw APIError.unpaired }
        var saved: Attachment?
        try await run { saved = try await client.uploadImage(data, name: name, mimeType: mimeType) }
        guard let saved else { throw APIError.badResponse }
        return saved
    }

    /// Whether the computer can turn speech into text (it has a Deepgram key).
    private(set) var dictationAvailable = false

    func dictationRequest() -> URLRequest? {
        client?.dictationRequest(thread: openThreadId)
    }

    func transcribe(_ audio: Data, mimeType: String) async throws -> String {
        guard let client else { throw APIError.unpaired }
        var text = ""
        try await run { text = try await client.transcribe(audio, mimeType: mimeType, thread: openThreadId) }
        return text
    }

    func stop() async throws {
        guard let client, let id = openThreadId else { return }
        try await run { try await client.stop(id) }
    }

    /// A thread went from working to done while the app is open: the finish sound, like the
    /// web's chime (in the background, the notification plays its own).
    private func announceFinished(_ next: [ThreadSummary]) {
        guard !threads.isEmpty, UIApplication.shared.applicationState == .active else { return }
        let before = Dictionary(threads.map { ($0.id, $0.status) }, uniquingKeysWith: { first, _ in first })
        let finished = next.contains { thread in
            guard thread.parentId == nil, thread.status == .completed, let was = before[thread.id] else { return false }
            return was.isRunning || was == .waiting
        }
        if finished { SoundEffects.playFinish() }
    }

    // MARK: Thread actions (press and hold in the list)

    func stop(_ id: String) async throws {
        guard let client else { return }
        try await run { try await client.stop(id) }
    }

    func rename(_ id: String, to title: String) async throws {
        guard let client else { return }
        try await run { try await client.rename(id, title: title) }
        if let index = threads.firstIndex(where: { $0.id == id }) { threads[index].title = title }
    }

    func regenerateTitle(_ id: String) async throws {
        guard let client else { return }
        try await run { try await client.regenerateTitle(id) }
        await refresh()
    }

    func markRead(_ id: String) async {
        guard let client else { return }
        try? await client.markRead(id)
        if let index = threads.firstIndex(where: { $0.id == id }) { threads[index].unread = false }
    }

    func deleteThread(_ id: String) async throws {
        guard let client else { return }
        try await run { try await client.deleteThread(id) }
        threads.removeAll { $0.id == id }
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

    func createThread(project: ProjectSummary?, choice: AgentChoice) async throws -> String? {
        guard let client else { return nil }
        var created: ChatThread?
        try await run { created = try await client.createThread(project: project, choice: choice) }
        return created?.id
    }

    /// What a new thread with this agent starts with: the settings last used on the computer.
    func defaultChoice(for provider: Provider) -> AgentChoice {
        let saved = ui?.agent?.settings?[provider.rawValue]
        return AgentChoice(provider: provider, model: saved?.model ?? "", effort: saved?.effort ?? "",
                           serviceTier: saved?.serviceTier ?? "",
                           permissionMode: saved?.permissionMode ?? PermissionMode.defaultValue)
    }

    // MARK: Models and agent settings

    /// Each agent's models, per project (they can differ by folder), kept while the app runs.
    private var modelLists: [String: [ModelOption]] = [:]

    func cachedModels(_ provider: Provider, cwd: String?) -> [ModelOption] {
        modelLists["\(provider.rawValue)|\(cwd ?? "")"] ?? []
    }

    func models(_ provider: Provider, cwd: String?) async -> [ModelOption] {
        let key = "\(provider.rawValue)|\(cwd ?? "")"
        if let cached = modelLists[key], !cached.isEmpty { return cached }
        guard let client, let models = try? await client.models(provider: provider, cwd: cwd) else { return [] }
        modelLists[key] = models
        return models
    }

    /// Changes the open thread's agent settings. The computer refuses while the agent works.
    func updateSettings(_ choice: AgentChoice) async throws {
        guard let client, let id = openThreadId else { return }
        try await run { try await client.updateSettings(id, to: choice) }
    }

    func pullRequest(of threadId: String) async -> PullRequest? {
        (try? await client?.pullRequest(threadId)) ?? nil
    }

    func diff(of threadId: String) async throws -> DiffResult {
        guard let client else { throw APIError.unpaired }
        var result: DiffResult?
        try await run { result = try await client.diff(threadId) }
        guard let result else { throw APIError.badResponse }
        return result
    }

    func branch(of threadId: String) async -> GitInfo? {
        try? await client?.git(threadId)
    }

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
        if let threads = update.threads, threads != self.threads {
            announceFinished(threads)
            self.threads = threads
            LiveActivities.shared.sync(threads)
        }
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
