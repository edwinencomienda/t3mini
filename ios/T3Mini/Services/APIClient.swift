import Foundation

enum APIError: LocalizedError, Equatable {
    /// The session expired or this phone was removed in Settings → Devices.
    case unpaired
    /// The computer couldn't be reached (Tailscale off, Mac asleep, other network).
    case unreachable(String)
    case server(Int, String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .unpaired:
            return "This iPhone isn’t connected anymore. Pair it again from Settings → Devices on your computer."
        case .unreachable(let reason):
            return "Can’t reach your computer. Is Tailscale on, on both devices? (\(reason))"
        case .server(_, let message): return message
        case .badResponse: return "Unexpected answer from t3 mini."
        }
    }
}

/// Talks to the paired computer's gateway. Cookies are never stored by URLSession: the session
/// comes from the Keychain and is added to each request, and redirects aren't followed, so it
/// can't be sent anywhere but the paired address.
final class APIClient: Sendable {
    let connection: Connection
    private let session: URLSession

    static let userAgent: String = {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        // The gateway names the device from this ("iPhone · t3 mini app"), see remote.ts.
        return "t3mini-ios/\(version) (\(isPad ? "iPad" : "iPhone"))"
    }()

    /// From the hardware model ("iPad13,4"), which any thread can read (UIDevice is main-actor only).
    private static var isPad: Bool {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated.hasPrefix("iPad")
        }
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var machine = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        let bytes = machine.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self).hasPrefix("iPad")
    }

    init(connection: Connection) {
        self.connection = connection
        session = Self.makeSession()
    }

    static func makeSession(timeout: TimeInterval = 30) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = timeout
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    // MARK: Pairing

    /// Trades a one-time code for a session, like pressing "Connect this device" on the pairing
    /// page: a form post to /pair, answered with a redirect that sets the session cookie.
    static func pair(_ link: PairingLink) async throws -> Connection {
        var request = URLRequest(url: link.server.appending(path: "pair"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "code", value: link.code)]
        request.httpBody = Data((form.percentEncodedQuery ?? "").utf8)
        let (_, response) = try await send(request, with: makeSession())
        guard response.statusCode == 303 else {
            if response.statusCode == 401 {
                throw APIError.server(401, "That code expired or was already used. Show a new QR code on your computer.")
            }
            throw APIError.server(response.statusCode, "Pairing failed (\(response.statusCode)).")
        }
        guard let cookie = sessionCookie(from: response) else { throw APIError.badResponse }
        return Connection(server: link.server, cookieName: cookie.name, cookieValue: cookie.value, pairedAt: Date())
    }

    /// The gateway's session cookie from a Set-Cookie header.
    static func sessionCookie(from response: HTTPURLResponse) -> (name: String, value: String)? {
        let header = response.value(forHTTPHeaderField: "Set-Cookie") ?? ""
        for name in ["__Host-t3m_session", "t3m_session"] {
            let prefix = "\(name)="
            guard let start = header.range(of: prefix) else { continue }
            let value = header[start.upperBound...].prefix { $0 != ";" && $0 != "," }
            if !value.isEmpty { return (name, String(value)) }
        }
        return nil
    }

    // MARK: Calls

    func bootstrap() async throws -> Bootstrap {
        try await call("bootstrap")
    }

    func thread(_ id: String) async throws -> ChatThread {
        let thread: ChatThread = try await call(threadPath(id))
        return Hub.machine(of: id).map { thread.onMachine($0) } ?? thread
    }

    /// The machines paired to the computer that are online (names only; GET /api/machines/hub).
    func hubMachines() async throws -> [HubMachine] {
        try await call("machines/hub")
    }

    // MARK: Other machines (Hub.swift)

    /// Where a machine's calls go: "m/<machine>/" before the API path; nothing for the computer's own.
    private func base(_ machine: String?) -> String {
        machine.map { "m/\($0.urlPathEscaped)/" } ?? ""
    }

    /// "threads/<id>" here, "m/<machine>/threads/<id>" for a machine's thread.
    private func threadPath(_ id: String) -> String {
        guard let hub = Hub.parse(id) else { return "threads/\(id.urlPathEscaped)" }
        return "\(base(hub.machine))threads/\(hub.id.urlPathEscaped)"
    }

    /// A saved image (an attachment, or one a tool showed), by its generated id.
    /// A saved video or sound (show_video, play_audio: GET /api/media/:id), downloaded with this
    /// phone's session to a temporary file. The caller moves it somewhere to keep.
    func downloadMedia(_ id: String, machine: String? = nil) async throws -> URL {
        let url = URL(string: "api/\(base(machine))media/\(id.urlPathEscaped)", relativeTo: connection.server)!.absoluteURL
        let (file, response) = try await session.download(for: authorized(URLRequest(url: url)))
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        if http.statusCode == 401 { throw APIError.unpaired }
        guard (200..<300).contains(http.statusCode) else { throw APIError.badResponse }
        return file
    }

    func image(_ id: String, machine: String? = nil) async throws -> Data {
        try await imageAt(URL(string: "api/\(base(machine))uploads/\(id.urlPathEscaped)", relativeTo: connection.server)!.absoluteURL)
    }

    /// An agent's HTML page (show_html), finished by the server: its CSP first (no network), the
    /// theme, and bundled libraries. Loaded into a sealed web view by HtmlPageView.
    func htmlPage(_ id: String, dark: Bool, inline: Bool, libraries: [String], machine: String? = nil) async throws -> String {
        var components = URLComponents(
            url: URL(string: "api/\(base(machine))html/\(id.urlPathEscaped)/page", relativeTo: connection.server)!.absoluteURL,
            resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "theme", value: dark ? "dark" : "light"),
            URLQueryItem(name: "inline", value: inline ? "1" : "0"),
            URLQueryItem(name: "libraries", value: libraries.joined(separator: ",")),
        ]
        let (data, response) = try await Self.send(authorized(URLRequest(url: components.url!)), with: session)
        if response.statusCode == 401 { throw APIError.unpaired }
        guard response.statusCode == 200 else { throw APIError.server(response.statusCode, "Page not found.") }
        return String(decoding: data, as: UTF8.self)
    }

    /// A project's own icon (its favicon or app icon).
    func projectIcon(_ path: String) async throws -> Data {
        let machine = Hub.machine(of: path)
        var components = URLComponents(
            url: URL(string: "api/\(base(machine))projects/icon", relativeTo: connection.server)!.absoluteURL,
            resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "path", value: Hub.local(path))]
        return try await imageAt(components.url!)
    }

    private func imageAt(_ url: URL) async throws -> Data {
        let (data, response) = try await Self.send(authorized(URLRequest(url: url)), with: session)
        if response.statusCode == 401 { throw APIError.unpaired }
        guard response.statusCode == 200, response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("image/") == true
        else { throw APIError.server(response.statusCode, "Image not found.") }
        return data
    }

    // MARK: Push notifications (src/server/push.ts → /api/push/app)

    struct PushStatus: Decodable { let configured: Bool; let registered: Bool }

    func pushStatus(token: String) async throws -> PushStatus {
        try await call("push/app?token=\(token)")
    }

    func registerPush(token: String, environment: String, topic: String, key: String?) async throws {
        var body = ["token": token, "environment": environment, "topic": topic]
        if let key { body["key"] = key }
        let _: Empty = try await call("push/app", method: "POST", body: body)
    }

    /// A Live Activity's push token for a thread (src/server/live-activities.ts).
    func registerActivity(token: String, thread: String, environment: String, topic: String) async throws {
        let body = ["token": token, "thread": thread, "environment": environment, "topic": topic]
        let _: Empty = try await call("push/activity", method: "POST", body: body)
    }

    func unregisterPush(token: String) async throws {
        let _: Empty = try await call("push/app", method: "DELETE", body: ["token": token])
    }

    func testPush(token: String) async throws {
        let _: Empty = try await call("push/app/test", method: "POST", body: ["token": token])
    }

    // MARK: Agent settings and git

    func models(provider: Provider, cwd: String?) async throws -> [ModelOption] {
        struct Catalog: Decodable { let models: [ModelOption] }
        var query = "\(base(Hub.machine(of: cwd)))models?provider=\(provider.rawValue)"
        if let cwd = cwd.map(Hub.local), let escaped = cwd.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))) {
            query += "&cwd=\(escaped)"
        }
        let catalog: Catalog = try await call(query)
        return catalog.models
    }

    func updateSettings(_ id: String, to choice: AgentChoice) async throws {
        let _: Empty = try await call("\(threadPath(id))/settings", method: "POST", body: [
            "provider": choice.provider.rawValue, "model": choice.model, "effort": choice.effort,
            "serviceTier": choice.serviceTier, "permissionMode": choice.permissionMode,
        ])
    }

    func pullRequest(_ id: String) async throws -> PullRequest? {
        struct Result: Decodable { let pullRequest: PullRequest? }
        let result: Result = try await call("\(threadPath(id))/pull-request")
        return result.pullRequest
    }

    func diff(_ id: String) async throws -> DiffResult {
        try await call("\(threadPath(id))/diff")
    }

    func git(_ id: String) async throws -> GitInfo {
        try await call("\(threadPath(id))/git")
    }

    func send(_ text: String, attachments: [Attachment] = [], to id: String) async throws {
        struct Body: Encodable {
            let text: String
            let attachments: [Item]
            struct Item: Encodable { let id: String; let name: String }
        }
        let _: Empty = try await call("\(threadPath(id))/send", method: "POST",
                                      body: Body(text: text, attachments: attachments.map { .init(id: $0.id, name: $0.name) }))
    }

    /// Saves a photo on the computer (POST /api/uploads); send it with a message by its id.
    /// Any other file: saved on the computer (like dropping a file on the web); returns its path
    /// there, for the message.
    func uploadFile(_ data: Data, name: String, mimeType: String, machine: String? = nil) async throws -> String {
        struct Saved: Decodable { let path: String }
        let saved: Saved = try await call("\(base(machine))uploads", method: "POST", body: [
            "kind": "file", "name": name, "mimeType": mimeType, "data": data.base64EncodedString(),
        ])
        return saved.path
    }

    func uploadImage(_ data: Data, name: String, mimeType: String, machine: String? = nil) async throws -> Attachment {
        struct Saved: Decodable { let id: String; let mimeType: String }
        let saved: Saved = try await call("\(base(machine))uploads", method: "POST", body: [
            "kind": "image", "name": name, "mimeType": mimeType, "data": data.base64EncodedString(),
        ])
        return Attachment(id: saved.id, name: name, mimeType: saved.mimeType)
    }

    /// The live dictation stream (WebSocket /api/dictation/stream): raw 16 kHz PCM up, words back.
    /// Sends the session and this gateway's own origin, as a browser would, so the gateway's usual
    /// checks apply.
    func dictationRequest(thread: String?) -> URLRequest? {
        guard var components = URLComponents(url: connection.server, resolvingAgainstBaseURL: false) else { return nil }
        let origin = connection.server.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/api/dictation/stream"
        components.queryItems = [
            URLQueryItem(name: "encoding", value: "linear16"),
            URLQueryItem(name: "sample_rate", value: "16000"),
        ] + (thread.map { [URLQueryItem(name: "thread", value: $0)] } ?? [])
        guard let url = components.url else { return nil }
        var request = authorized(URLRequest(url: url))
        request.setValue(origin, forHTTPHeaderField: "Origin")
        return request
    }

    /// Speech to text on the computer (POST /api/transcribe, its Deepgram key), with the thread's
    /// vocabulary for names and terms.
    /// A Dictation-only token to send a recording straight to AssemblyAI (the computer mints it).
    func dictationToken(thread: String?) async throws -> DictationToken {
        var body: [String: String] = [:]
        if let thread { body["thread"] = thread }
        return try await call("dictation/token", method: "POST", body: body)
    }

    /// The recording, straight to AssemblyAI's Dictation API with the short-lived token. Its
    /// cleaned-up text (or the verbatim one when the cleanup didn't come back).
    nonisolated static func dictate(_ audio: Data, mimeType: String, with token: DictationToken) async throws -> String {
        guard token.url.scheme == "https", token.url.host?.hasSuffix(".assemblyai.com") == true else {
            throw APIError.badResponse
        }
        let boundary = "t3mini-\(UUID().uuidString)"
        var request = URLRequest(url: token.url, timeoutInterval: 90)
        request.httpMethod = "POST"
        request.setValue(token.token, forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = multipart(config: try JSONEncoder().encode(token.config), audio: audio,
                                     mimeType: mimeType, boundary: boundary)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(http.statusCode, http.statusCode == 401
                ? "AssemblyAI didn’t accept the dictation token."
                : "AssemblyAI could not transcribe this (\(http.statusCode)).")
        }
        struct Result: Decodable { let text: String?; let llm_response: String? }
        let result = try JSONDecoder().decode(Result.self, from: data)
        let cleaned = result.llm_response?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return cleaned.isEmpty ? (result.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : cleaned
    }

    /// multipart/form-data with the config first, then the audio (AssemblyAI's order).
    nonisolated static func multipart(config: Data, audio: Data, mimeType: String, boundary: String) -> Data {
        var body = Data()
        func line(_ text: String) { body.append(Data((text + "\r\n").utf8)) }
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"config\"")
        line("Content-Type: application/json")
        line("")
        body.append(config)
        line("")
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"audio\"; filename=\"recording.m4a\"")
        line("Content-Type: \(mimeType)")
        line("")
        body.append(audio)
        line("")
        line("--\(boundary)--")
        return body
    }

    func transcribe(_ audio: Data, mimeType: String, thread: String?) async throws -> String {
        struct Result: Decodable { let text: String }
        var body = ["mimeType": mimeType, "data": audio.base64EncodedString()]
        if let thread { body["thread"] = thread }
        let result: Result = try await call("transcribe", method: "POST", body: body)
        return result.text
    }

    func stop(_ id: String) async throws {
        let _: Empty = try await call("\(threadPath(id))/stop", method: "POST", body: [String: String]())
    }

    func rename(_ id: String, title: String) async throws {
        let _: Empty = try await call("\(threadPath(id))/rename", method: "POST", body: ["title": title])
    }

    /// A fresh AI title from the conversation (Claude's session title, Luna for Codex).
    func regenerateTitle(_ id: String) async throws {
        let _: Empty = try await call("\(threadPath(id))/title", method: "POST", body: [String: String]())
    }

    /// Deletes the thread on the computer (refused while its agent works).
    func deleteThread(_ id: String) async throws {
        let _: Empty = try await call("\(threadPath(id))", method: "DELETE")
    }

    func markRead(_ id: String) async throws {
        let _: Empty = try await call("\(threadPath(id))/read", method: "POST", body: [String: String]())
    }

    func approve(_ id: String, approvalId: String, allow: Bool, answers: [String: String]? = nil) async throws {
        struct Body: Encodable { let approvalId: String; let allow: Bool; let answers: [String: String]? }
        let _: Empty = try await call(
            "\(threadPath(id))/approve", method: "POST",
            body: Body(approvalId: approvalId, allow: allow, answers: answers))
    }

    /// request_secret: the value goes to the computer's env file (only over HTTPS: the computer
    /// refuses it on the plain local network). Nothing is returned or kept here.
    func provideSecret(_ id: String, approvalId: String, value: String) async throws {
        struct Body: Encodable { let approvalId: String; let value: String }
        let _: Empty = try await call(
            "\(threadPath(id))/secret", method: "POST",
            body: Body(approvalId: approvalId, value: value))
    }

    func createThread(project: ProjectSummary?, choice: AgentChoice) async throws -> ChatThread {
        try await createThread(provider: choice.provider, project: project, settings: AgentSettings(
            model: choice.model, effort: choice.effort, permissionMode: choice.permissionMode,
            serviceTier: choice.serviceTier.isEmpty ? nil : choice.serviceTier))
    }

    func createThread(provider: Provider, project: ProjectSummary?, settings: AgentSettings?) async throws -> ChatThread {
        struct Body: Encodable {
            let provider: Provider
            let cwd: String?
            let noProject: Bool?
            let model: String?
            let effort: String?
            let permissionMode: String?
            let serviceTier: String?
        }
        // A machine's project: created on that machine, with its own folder path.
        let machine = Hub.machine(of: project?.path)
        let body = Body(
            provider: provider,
            cwd: project?.chats == true ? nil : project.map { Hub.local($0.path) },
            noProject: project == nil || project?.chats == true ? true : nil,
            model: settings?.model, effort: settings?.effort,
            permissionMode: settings?.permissionMode, serviceTier: settings?.serviceTier)
        let created: ChatThread = try await call("\(base(machine))threads", method: "POST", body: body)
        return machine.map { created.onMachine($0) } ?? created
    }

    /// Live updates (Server-Sent Events). `thread`: the open thread, sent whole then as patches.
    /// `machine`: another machine's updates (its threads and projects, and `thread` on it, by its
    /// own id), through the computer.
    func events(thread: String?, machine: String? = nil) -> AsyncThrowingStream<LiveUpdate, Error> {
        var components = URLComponents(
            url: URL(string: "api/\(base(machine))events", relativeTo: connection.server)!.absoluteURL,
            resolvingAgainstBaseURL: false)!
        // append=1: a streaming reply comes as just its new text (servers that don't know it ignore it).
        components.queryItems = [URLQueryItem(name: "patch", value: "1"), URLQueryItem(name: "append", value: "1")]
            + (thread.map { [URLQueryItem(name: "thread", value: $0)] } ?? [])
        var streamRequest = authorized(URLRequest(url: components.url!))
        streamRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Events stream for as long as the screen is open; the server sends a keepalive every 15 s.
        streamRequest.timeoutInterval = 60
        let request = streamRequest
        let session = Self.makeSession(timeout: 60)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
                    if http.statusCode == 401 { throw APIError.unpaired }
                    guard http.statusCode == 200 else { throw APIError.server(http.statusCode, "Live updates failed (\(http.statusCode)).") }
                    var parser = EventStreamParser()
                    var line = Data()
                    // Byte by byte: AsyncBytes.lines skips the blank lines that end each event.
                    for try await byte in bytes {
                        if byte == UInt8(ascii: "\n") {
                            if line.last == UInt8(ascii: "\r") { line.removeLast() }
                            if let data = parser.feed(String(decoding: line, as: UTF8.self)) {
                                continuation.yield(try JSONDecoder().decode(LiveUpdate.self, from: Data(data.utf8)))
                            }
                            line.removeAll(keepingCapacity: true)
                        } else {
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch let error as URLError where error.code == .cancelled {
                    continuation.finish()
                } catch let error as URLError {
                    continuation.finish(throwing: APIError.unreachable(error.localizedDescription))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
                session.invalidateAndCancel()
            }
        }
    }

    // MARK: Plumbing

    private struct Empty: Decodable {}
    /// The server's error answer: {"error": "…"}.
    private struct Failure: Decodable { let error: String }

    private func authorized(_ request: URLRequest) -> URLRequest {
        var request = request
        request.setValue(connection.cookieHeader, forHTTPHeaderField: "Cookie")
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        return request
    }

    private func call<T: Decodable>(_ path: String, method: String = "GET", body: (any Encodable)? = nil) async throws -> T {
        var request = authorized(URLRequest(url: URL(string: "api/\(path)", relativeTo: connection.server)!.absoluteURL))
        request.httpMethod = method
        // The server takes changes only as JSON (its guard against cross-site requests), so a
        // POST or DELETE without a body still sends an empty JSON object.
        if body != nil || method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try body.map { try JSONEncoder().encode($0) } ?? Data("{}".utf8)
        }
        let (data, response) = try await Self.send(request, with: session)
        if response.statusCode == 401 { throw APIError.unpaired }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error
            throw APIError.server(response.statusCode, message ?? "Request failed (\(response.statusCode)).")
        }
        if T.self == Empty.self { return Empty() as! T }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.badResponse
        }
    }

    private static func send(_ request: URLRequest, with session: URLSession) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
            return (data, http)
        } catch let error as URLError {
            throw APIError.unreachable(error.localizedDescription)
        }
    }
}

/// Returns redirects to the caller instead of following them (the pairing answer is a 303).
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}

private extension String {
    var urlPathEscaped: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? self
    }
}
