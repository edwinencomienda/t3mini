import ActivityKit
import Foundation

/// A thread's Live Activity (lock screen and Dynamic Island), shared by the app (which starts it)
/// and the widget extension (which draws it).
///
/// The attributes are set on the phone when the activity starts and never change; they hold the
/// only text (title, project). The content state is what the computer updates through Apple's
/// push service (src/server/live-activities.ts → activityState): status, step count, and times,
/// no text, since Apple can read those updates.
struct ThreadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// "working", "waiting", "done", "failed", or "stopped".
        var status: String
        var steps: Int
        /// Unix seconds: when your message went out, and when the turn ended.
        var startedAt: Double
        var endedAt: Double?
    }

    var threadId: String
    var title: String
    var project: String
    /// "claude" or "codex".
    var provider: String
}

extension ThreadActivityAttributes.ContentState {
    var started: Date { Date(timeIntervalSince1970: startedAt) }
    var ended: Date? { endedAt.map { Date(timeIntervalSince1970: $0) } }
    var isOver: Bool { status == "done" || status == "failed" || status == "stopped" }

    var statusLabel: String {
        switch status {
        case "waiting": "Waiting for you"
        case "done": "Done"
        case "failed": "Failed"
        case "stopped": "Stopped"
        default: "Working"
        }
    }

    var symbol: String {
        switch status {
        case "waiting": "hand.raised.fill"
        case "done": "checkmark.circle.fill"
        case "failed": "xmark.octagon.fill"
        case "stopped": "stop.circle.fill"
        default: "sparkle"
        }
    }

    /// "Working · 12 steps", "Done in 2m 10s · 12 steps".
    var detail: String {
        var parts = [statusLabel]
        if let ended, isOver { parts = ["\(statusLabel) in \(Self.duration(ended.timeIntervalSince(started)))"] }
        if steps > 0 { parts.append("\(steps) step\(steps == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total < 60 { return "\(total)s" }
        let minutes = total / 60
        if minutes < 60 { return total % 60 == 0 ? "\(minutes)m" : "\(minutes)m \(total % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }
}

enum ThreadLink {
    /// t3mini://thread/<id>: opens the thread (the activity's tap).
    static func url(for threadId: String) -> URL? {
        guard let id = threadId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        return URL(string: "t3mini://thread/\(id)")
    }

    /// The thread id from such a link, if it is one (ids are letters, digits, - and _).
    static func threadId(from url: URL) -> String? {
        guard url.scheme == "t3mini", url.host == "thread", url.query == nil, url.fragment == nil,
              url.pathComponents.count == 2, let id = url.pathComponents.last else { return nil }
        guard !id.isEmpty, id.count <= 100, id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        else { return nil }
        return id
    }
}
