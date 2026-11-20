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
    var id: String
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
    /// Another machine's thread (Hub.swift): that machine's name. Nil for the computer's own.
    var machine: String?
}

struct ProjectSummary: Codable, Identifiable, Hashable, Sendable {
    var path: String
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
    /// Another machine's project (Hub.swift): that machine's name. Nil for the computer's own.
    var machine: String?
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
    /// Settings → Appearance → Animations on the computer (the working characters).
    var animations: Bool?
    /// The sidebar's Group by on the computer: "project", "date", or "none".
    var groupBy: String?
}

struct Bootstrap: Codable, Sendable {
    var threads: [ThreadSummary]
    var projects: [ProjectSummary]
    var ui: UiSettings?
    var defaultCwd: String?
    /// The computer has a dictation key (Deepgram or AssemblyAI), so the message box offers it.
    var dictation: Bool?
    /// Words stream in while you talk (Deepgram); false: the recording is sent whole when you
    /// stop (AssemblyAI's Dictation API).
    var dictationLive: Bool?
    /// AssemblyAI: the recording can go straight to AssemblyAI with a short-lived token.
    var dictationDirect: Bool?
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
    /// Your message's turn's to-do checklist, saved when the turn ended.
    var todos: [Todo]?

    enum Role: String, Codable, Sendable { case user, assistant }
}

struct Activity: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String
    var summary: String?
    var title: String?
    var status: String
    var todo: Bool?
    var startedAt: String?

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
    /// request_secret: the variable the agent needs, why, and the env file it goes to.
    var secret: SecretRequest?
}

/// What a secret card asks for. The value itself is never part of the thread.
struct SecretRequest: Codable, Hashable, Sendable {
    var name: String
    var reason: String
    var file: String
}

/// The fields of a thread other than its messages and steps (a patch's `rest`).
struct ThreadInfo: Codable, Hashable, Sendable {
    var id: String
    var title: String
    var provider: Provider
    var cwd: String
    var model: String?
    var effort: String?
    var permissionMode: String?
    var serviceTier: String?
    var worktree: Worktree?
    var completedAt: String?
    var status: ThreadStatus
    var approvals: [Approval]
    var error: String?
    /// The agent's latest to-do checklist (live while it runs).
    var todos: [Todo]?

    /// A worktree thread works on its own branch (server/worktrees.ts).
    struct Worktree: Codable, Hashable, Sendable { var branch: String }

    var settings: AgentChoice {
        AgentChoice(provider: provider, model: model ?? "", effort: effort ?? "",
                    serviceTier: serviceTier ?? "", permissionMode: permissionMode ?? PermissionMode.defaultValue)
    }
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

/// The agent's to-do checklist (update_checklist; Claude's TodoWrite, Codex's plan).
struct Todo: Codable, Hashable, Sendable, Identifiable {
    let id: String
    var text: String
    var activeText: String?
    /// "pending", "in_progress", or "completed".
    var status: String
}

/// A live status card (show_status): a push, pull request, deploy, release, or other long step.
struct StatusInfo: Codable, Hashable, Sendable {
    struct Commit: Codable, Hashable, Sendable { var sha: String; var message: String }
    var kind: String?
    var status: String
    var title: String
    var detail: String?
    var stages: [String]?
    var stage: String?
    var commits: [Commit]?
    /// Always https (checked by the tool, and again before opening).
    var url: String?
    var urlLabel: String?
    var error: String?
    var startedAt: String?
    var endedAt: String?
}

/// A sub-agent's card (delegate_task); `id` is its own (hidden) thread.
struct DelegationInfo: Codable, Hashable, Sendable {
    struct Progress: Codable, Hashable, Sendable { var done: Int; var total: Int }
    var id: String?
    var title: String
    var agent: Provider?
    var access: String?
    var background: Bool?
    var status: String
    var step: String?
    var todos: Progress?
    var files: [String]?
    var overlaps: [String]?
    var answer: String?
    var error: String?
    var startedAt: String?
    var endedAt: String?
}

/// Content a tool added to a reply (src/blocks.ts). Types the app doesn't draw yet still decode,
/// as `.other`, so they can say "open on your computer" instead of vanishing or failing the thread.
enum Block: Codable, Hashable, Sendable {
    case image(id: String, caption: String?)
    /// A page from show_html: its id, title, and bundled libraries ("chart.js").
    case html(id: String, title: String?, libraries: [String])
    /// A Mermaid diagram from show_diagram: its source (drawn on the phone) and title.
    case diagram(source: String, title: String?)
    case status(StatusInfo)
    case delegation(DelegationInfo)
    /// show_video / play_audio: a saved file served at /api/media/<id>.
    case video(id: String, caption: String?)
    case audio(id: String, caption: String?)
    case other(type: String, title: String?)

    private enum Keys: String, CodingKey { case type, id, caption, title, source, libraries }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = (try? c.decode(String.self, forKey: .type)) ?? ""
        let string = { (key: Keys) in (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        switch type {
        case "image", "video", "audio":
            guard let id = string(.id) else { self = .other(type: type, title: nil); return }
            let caption = string(.caption)
            self = type == "image" ? .image(id: id, caption: caption)
                : type == "video" ? .video(id: id, caption: caption) : .audio(id: id, caption: caption)
        case "html":
            guard let id = string(.id) else { self = .other(type: type, title: nil); return }
            self = .html(id: id, title: string(.title),
                         libraries: (try? c.decodeIfPresent([String].self, forKey: .libraries)) ?? [])
        case "diagram":
            guard let source = string(.source), !source.isEmpty else { self = .other(type: type, title: nil); return }
            self = .diagram(source: source, title: string(.title))
        case "status":
            guard let info = try? StatusInfo(from: decoder) else { self = .other(type: type, title: string(.title)); return }
            self = .status(info)
        case "delegation":
            guard let info = try? DelegationInfo(from: decoder) else { self = .other(type: type, title: string(.title)); return }
            self = .delegation(info)
        default:
            self = .other(type: type, title: string(.title) ?? string(.caption))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .image(let id, let caption), .video(let id, let caption), .audio(let id, let caption):
            let type = if case .image = self { "image" } else if case .video = self { "video" } else { "audio" }
            try c.encode(type, forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encodeIfPresent(caption, forKey: .caption)
        case .html(let id, let title, let libraries):
            try c.encode("html", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encodeIfPresent(title, forKey: .title)
            try c.encode(libraries, forKey: .libraries)
        case .diagram(let source, let title):
            try c.encode("diagram", forKey: .type)
            try c.encode(source, forKey: .source)
            try c.encodeIfPresent(title, forKey: .title)
        case .status(let info):
            try c.encode("status", forKey: .type)
            try info.encode(to: encoder)
        case .delegation(let info):
            try c.encode("delegation", forKey: .type)
            try info.encode(to: encoder)
        case .other(let type, let title):
            try c.encode(type, forKey: .type)
            try c.encodeIfPresent(title, forKey: .title)
        }
    }
}


// MARK: Agent settings (src/agent-settings.ts)

/// A model the computer offers for an agent (GET /api/models), with its reasoning levels and speeds.
struct ModelOption: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String
    var description: String?
    var efforts: [String]
    var defaultEffort: String?
    var isDefault: Bool?
    var serviceTiers: [ServiceTier]?

    struct ServiceTier: Codable, Hashable, Sendable {
        let id: String
        var label: String
        var description: String?
    }
}

/// The permission modes, as the web app words them (src/agent-settings.ts → permissionModes).
struct PermissionMode: Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let description: String
    let symbol: String

    static let all: [PermissionMode] = [
        PermissionMode(id: "approval-required", label: "Approval required",
                       description: "Ask before actions that need approval.", symbol: "hand.raised"),
        PermissionMode(id: "auto-accept-edits", label: "Auto-accept edits",
                       description: "Allow project edits; ask when other actions need approval.", symbol: "pencil"),
        PermissionMode(id: "auto", label: "Auto",
                       description: "Let the provider review and approve actions automatically.", symbol: "wand.and.stars"),
        PermissionMode(id: "full-access", label: "Full access",
                       description: "Run with full system access and bypass normal permission prompts.", symbol: "bolt.shield"),
    ]
    static let defaultValue = "full-access"
    static func named(_ id: String) -> PermissionMode? { all.first { $0.id == id } }
}

/// What a thread runs with: the agent, its model, reasoning level, speed, and permission.
/// Empty model / effort / tier: the agent's default.
struct AgentChoice: Hashable, Sendable {
    var provider: Provider
    var model: String
    var effort: String
    var serviceTier: String
    var permissionMode: String

    /// "Extra high" for "xhigh", like the web app's effortLabel.
    static func effortLabel(_ value: String) -> String {
        switch value {
        case "": return "Default"
        case "xhigh": return "Extra high"
        default: return value.prefix(1).uppercased() + value.dropFirst()
        }
    }

    /// Keeps the choice valid for the models on offer: a model that isn't there goes back to the
    /// default, and an effort or speed the model doesn't have goes back to the default too.
    func fitted(to models: [ModelOption]) -> AgentChoice {
        var next = self
        guard !models.isEmpty else { return next }
        if !next.model.isEmpty, !models.contains(where: { $0.id == next.model }) { next.model = "" }
        let current = models.first { $0.id == next.model } ?? models.first { $0.isDefault == true }
        if let current {
            if !next.effort.isEmpty, !current.efforts.contains(next.effort) { next.effort = "" }
            if !next.serviceTier.isEmpty, !(current.serviceTiers ?? []).contains(where: { $0.id == next.serviceTier }) {
                next.serviceTier = ""
            }
        }
        return next
    }
}

/// The open pull request for the thread's branch, if any (GET /api/threads/:id/pull-request).
struct PullRequest: Codable, Hashable, Sendable {
    var number: Int
    var url: String
}

/// The project's uncommitted changes (GET /api/threads/:id/diff; src/diff.ts).
struct DiffLine: Codable, Hashable, Sendable {
    /// "add", "del", or "ctx".
    var type: String
    var old: Int?
    var new: Int?
    var text: String
}

struct DiffHunk: Codable, Hashable, Sendable {
    var header: String
    var lines: [DiffLine]
}

struct DiffFile: Codable, Hashable, Sendable, Identifiable {
    var path: String
    var oldPath: String?
    /// "added", "deleted", "modified", or "renamed".
    var status: String
    var additions: Int
    var deletions: Int
    var binary: Bool
    var tooLarge: Bool?
    var hunks: [DiffHunk]
    var id: String { path }
}

struct DiffResult: Codable, Hashable, Sendable {
    var repo: Bool
    var files: [DiffFile]
    var truncated: Bool
    var totalFiles: Int
}

/// The thread's branch (GET /api/threads/:id/git).
struct GitInfo: Codable, Hashable, Sendable {
    var branch: String?
    var detached: Bool?
}

/// A short-lived, Dictation-only AssemblyAI token from the computer (never its API key), where
/// to send the recording, and the config to send with it.
struct DictationToken: Decodable, Sendable {
    struct Config: Codable, Sendable {
        var rewrite_mode: String?
        var keyterms_prompt: [String]?
    }
    let token: String
    let url: URL
    let config: Config
}
