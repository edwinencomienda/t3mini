import Foundation

// The parts of t3 mini's API types (src/types.ts) the app uses. Every field the app doesn't need
// is left out, and anything that can be missing is optional, so a newer server still decodes.

enum Provider: String, Codable, CaseIterable, Identifiable, Sendable {
    case claude, codex
    var id: String { rawValue }
    var label: String { self == .claude ? "Claude" : "Codex" }
}

enum ThreadStatus: String, Codable, Sendable {
    case idle, starting, working, waiting, completed, interrupted, failed
    case unknown

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = ThreadStatus(rawValue: value) ?? .unknown
    }

    /// The agent is busy on this thread right now.
    var isRunning: Bool { self == .starting || self == .working }
}

struct ThreadSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var provider: Provider
    var cwd: String
    var status: ThreadStatus
    var updatedAt: String
    var lastMessageAt: String?
    var waitingFor: String?
    var parentId: String?
    var chat: Bool?
    var unread: Bool?
}

struct ProjectSummary: Codable, Identifiable, Hashable, Sendable {
    let path: String
    var name: String?
    var chats: Bool?
    var lastActiveAt: String?
    /// When it was added: the order projects keep when grouped (they don't jump around).
    var addedAt: String?
    /// It has its own icon (a favicon or app icon), served at /api/projects/icon?path=…
    var icon: Bool?
    /// Chosen in Project settings on the computer: "letter", "image" (with `image`, an upload id).
    var avatar: String?
    var image: String?
    var id: String { path }

    var displayName: String {
        if chats == true { return "No project" }
        if let name, !name.isEmpty { return name }
        return (path as NSString).lastPathComponent
    }
}

struct AgentSettings: Codable, Hashable, Sendable {
    var model: String?
    var effort: String?
    var permissionMode: String?
    var serviceTier: String?
}

struct UiSettings: Codable, Equatable, Sendable {
    struct Agent: Codable, Equatable, Sendable {
        var provider: Provider?
        var cwd: String?
        var settings: [String: AgentSettings]?
    }
    var agent: Agent?
    /// Settings → Project icons on the computer (off: letters only).
    var projectIcons: Bool?
    /// The sidebar's Group by on the computer: "project", "date", or "none".
    var groupBy: String?
}

struct Bootstrap: Codable, Sendable {
    var threads: [ThreadSummary]
    var projects: [ProjectSummary]
    var ui: UiSettings?
    var defaultCwd: String?
}

struct Attachment: Codable, Hashable, Sendable {
    let id: String
    var name: String
    var mimeType: String
}

struct HelperReport: Codable, Hashable, Sendable {
    var title: String
    var status: String
    var answer: String
}

struct Message: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var role: Role
    var text: String
    var createdAt: String
    var attachments: [Attachment]?
    var blocks: [Block]?
    var queued: Bool?
    var unsent: Bool?
    var report: HelperReport?

    enum Role: String, Codable, Sendable { case user, assistant }
}

struct Activity: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String
    var summary: String?
    var title: String?
    var status: String
    var todo: Bool?

    /// One line for the working indicator, e.g. "Run · bun run test".
    var line: String {
        if let title, !title.isEmpty { return title }
        if let summary, !summary.isEmpty { return "\(label) · \(summary)" }
        return label
    }
}

struct QuestionOption: Codable, Hashable, Sendable {
    var label: String
    var description: String?
}

struct Question: Codable, Hashable, Sendable {
    var question: String
    var header: String?
    var multiSelect: Bool?
    var options: [QuestionOption]
}

struct Approval: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var detail: String
    var questions: [Question]?
}

/// The fields of a thread other than its messages and steps (a patch's `rest`).
struct ThreadInfo: Codable, Hashable, Sendable {
    let id: String
    var title: String
    var provider: Provider
    var cwd: String
    var model: String?
    var status: ThreadStatus
    var approvals: [Approval]
    var error: String?
}

/// A whole thread. Decoded from one JSON object holding the info and both lists.
struct ChatThread: Hashable, Sendable {
    var info: ThreadInfo
    var messages: [Message]
    var activities: [Activity]
    var id: String { info.id }
}

extension ChatThread: Codable {
    private enum Keys: String, CodingKey { case messages, activities }

    init(from decoder: Decoder) throws {
        info = try ThreadInfo(from: decoder)
        let lists = try decoder.container(keyedBy: Keys.self)
        messages = try lists.decodeIfPresent([Message].self, forKey: .messages) ?? []
        activities = try lists.decodeIfPresent([Activity].self, forKey: .activities) ?? []
    }

    func encode(to encoder: Encoder) throws {
        try info.encode(to: encoder)
        var lists = encoder.container(keyedBy: Keys.self)
        try lists.encode(messages, forKey: .messages)
        try lists.encode(activities, forKey: .activities)
    }
}

/// Content a tool added to a reply (src/blocks.ts). Types the app doesn't draw yet still decode,
/// as `.other`, so they can say "open on your computer" instead of vanishing or failing the thread.
enum Block: Codable, Hashable, Sendable {
    case image(id: String, caption: String?)
    /// A page from show_html: its id, title, and bundled libraries ("chart.js").
    case html(id: String, title: String?, libraries: [String])
    case status(title: String, status: String, detail: String?, url: String?)
    case delegation(title: String, status: String, step: String?)
    case other(type: String, title: String?)

    private enum Keys: String, CodingKey { case type, id, caption, title, status, detail, url, step, source, libraries }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = (try? c.decode(String.self, forKey: .type)) ?? ""
        let string = { (key: Keys) in try? c.decodeIfPresent(String.self, forKey: key) }
        switch type {
        case "image":
            guard let id = string(.id) ?? nil else { self = .other(type: type, title: nil); return }
            self = .image(id: id, caption: string(.caption) ?? nil)
        case "html":
            guard let id = string(.id) ?? nil else { self = .other(type: type, title: nil); return }
            self = .html(id: id, title: string(.title) ?? nil,
                         libraries: (try? c.decodeIfPresent([String].self, forKey: .libraries)) ?? [])
        case "status":
            self = .status(title: (string(.title) ?? nil) ?? "Status", status: (string(.status) ?? nil) ?? "running",
                           detail: string(.detail) ?? nil, url: string(.url) ?? nil)
        case "delegation":
            self = .delegation(title: (string(.title) ?? nil) ?? "Sub-agent", status: (string(.status) ?? nil) ?? "running",
                               step: string(.step) ?? nil)
        default:
            self = .other(type: type, title: (string(.title) ?? nil) ?? (string(.caption) ?? nil))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .image(let id, let caption):
            try c.encode("image", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encodeIfPresent(caption, forKey: .caption)
        case .html(let id, let title, let libraries):
            try c.encode("html", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encodeIfPresent(title, forKey: .title)
            try c.encode(libraries, forKey: .libraries)
        case .status(let title, let status, let detail, let url):
            try c.encode("status", forKey: .type)
            try c.encode(title, forKey: .title)
            try c.encode(status, forKey: .status)
            try c.encodeIfPresent(detail, forKey: .detail)
            try c.encodeIfPresent(url, forKey: .url)
        case .delegation(let title, let status, let step):
            try c.encode("delegation", forKey: .type)
            try c.encode(title, forKey: .title)
            try c.encode(status, forKey: .status)
            try c.encodeIfPresent(step, forKey: .step)
        case .other(let type, let title):
            try c.encode(type, forKey: .type)
            try c.encodeIfPresent(title, forKey: .title)
        }
    }
}
