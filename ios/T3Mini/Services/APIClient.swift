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
        try await call("threads/\(id.urlPathEscaped)")
    }

    /// A saved image (an attachment, or one a tool showed), by its generated id.
    func image(_ id: String) async throws -> Data {
        try await imageAt(URL(string: "api/uploads/\(id.urlPathEscaped)", relativeTo: connection.server)!.absoluteURL)
    }

    /// An agent's HTML page (show_html), finished by the server: its CSP first (no network), the
    /// theme, and bundled libraries. Loaded into a sealed web view by HtmlPageView.
    func htmlPage(_ id: String, dark: Bool, inline: Bool, libraries: [String]) async throws -> String {
        var components = URLComponents(
            url: connection.server.appending(path: "api/html/\(id.urlPathEscaped)/page"), resolvingAgainstBaseURL: false)!
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
        var components = URLComponents(url: connection.server.appending(path: "api/projects/icon"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "path", value: path)]
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

    func unregisterPush(token: String) async throws {
        let _: Empty = try await call("push/app", method: "DELETE", body: ["token": token])
    }

    func testPush(token: String) async throws {
        let _: Empty = try await call("push/app/test", method: "POST", body: ["token": token])
    }

    // MARK: Agent settings and git

    func models(provider: Provider, cwd: String?) async throws -> [ModelOption] {
        struct Catalog: Decodable { let models: [ModelOption] }
        var query = "models?provider=\(provider.rawValue)"
        if let cwd, let escaped = cwd.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#"))) {
            query += "&cwd=\(escaped)"
        }
        let catalog: Catalog = try await call(query)
        return catalog.models
    }

    func updateSettings(_ id: String, to choice: AgentChoice) async throws {
        let _: Empty = try await call("threads/\(id.urlPathEscaped)/settings", method: "POST", body: [
            "provider": choice.provider.rawValue, "model": choice.model, "effort": choice.effort,
            "serviceTier": choice.serviceTier, "permissionMode": choice.permissionMode,
        ])
    }

    func git(_ id: String) async throws -> GitInfo {
        try await call("threads/\(id.urlPathEscaped)/git")
    }

    func send(_ text: String, attachments: [Attachment] = [], to id: String) async throws {
        struct Body: Encodable {
            let text: String
            let attachments: [Item]
            struct Item: Encodable { let id: String; let name: String }
        }
        let _: Empty = try await call("threads/\(id.urlPathEscaped)/send", method: "POST",
                                      body: Body(text: text, attachments: attachments.map { .init(id: $0.id, name: $0.name) }))
    }

    /// Saves a photo on the computer (POST /api/uploads); send it with a message by its id.
    func uploadImage(_ data: Data, name: String, mimeType: String) async throws -> Attachment {
        struct Saved: Decodable { let id: String; let mimeType: String }
        let saved: Saved = try await call("uploads", method: "POST", body: [
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
    func transcribe(_ audio: Data, mimeType: String, thread: String?) async throws -> String {
        struct Result: Decodable { let text: String }
        var body = ["mimeType": mimeType, "data": audio.base64EncodedString()]
        if let thread { body["thread"] = thread }
        let result: Result = try await call("transcribe", method: "POST", body: body)
        return result.text
    }

    func stop(_ id: String) async throws {
        let _: Empty = try await call("threads/\(id.urlPathEscaped)/stop", method: "POST", body: [String: String]())
    }

    func rename(_ id: String, title: String) async throws {
        let _: Empty = try await call("threads/\(id.urlPathEscaped)/rename", method: "POST", body: ["title": title])
    }

    /// A fresh AI title from the conversation (Claude's session title, Luna for Codex).
    func regenerateTitle(_ id: String) async throws {
        let _: Empty = try await call("threads/\(id.urlPathEscaped)/title", method: "POST", body: [String: String]())
    }

    /// Deletes the thread on the computer (refused while its agent works).
    func deleteThread(_ id: String) async throws {
        let _: Empty = try await call("threads/\(id.urlPathEscaped)", method: "DELETE")
    }

    func markRead(_ id: String) async throws {
        let _: Empty = try await call("threads/\(id.urlPathEscaped)/read", method: "POST", body: [String: String]())
    }

    func approve(_ id: String, approvalId: String, allow: Bool, answers: [String: String]? = nil) async throws {
        struct Body: Encodable { let approvalId: String; let allow: Bool; let answers: [String: String]? }
        let _: Empty = try await call(
            "threads/\(id.urlPathEscaped)/approve", method: "POST",
            body: Body(approvalId: approvalId, allow: allow, answers: answers))
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
        let body = Body(
            provider: provider,
            cwd: project?.chats == true ? nil : project?.path,
            noProject: project == nil || project?.chats == true ? true : nil,
            model: settings?.model, effort: settings?.effort,
            permissionMode: settings?.permissionMode, serviceTier: settings?.serviceTier)
        return try await call("threads", method: "POST", body: body)
    }

    /// Live updates (Server-Sent Events). `thread`: the open thread, sent whole then as patches.
    func events(thread: String?) -> AsyncThrowingStream<LiveUpdate, Error> {
        var components = URLComponents(url: connection.server.appending(path: "api/events"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "patch", value: "1")]
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
