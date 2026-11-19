import Foundation

// Live updates from /api/events (see src/thread-patch.ts and changedParts() in api.ts).
// Each event holds only the parts that changed; a missing key means "unchanged", so only
// present keys are applied. The open thread comes whole once, then as patches.

/// A list's new length and the items that changed, by position.
struct ListPatch<Item: Decodable & Sendable>: Decodable, Sendable {
    var count: Int
    var changed: [(Int, Item)]

    private enum Keys: String, CodingKey { case count, changed }

    init(count: Int, changed: [(Int, Item)]) {
        self.count = count
        self.changed = changed
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        count = try container.decode(Int.self, forKey: .count)
        var pairs = try container.nestedUnkeyedContainer(forKey: .changed)
        var changed: [(Int, Item)] = []
        while !pairs.isAtEnd {
            // Each change is a two-item array: [index, item].
            var pair = try pairs.nestedUnkeyedContainer()
            let index = try pair.decode(Int.self)
            let item = try pair.decode(Item.self)
            changed.append((index, item))
        }
        self.changed = changed
    }

    func apply(to previous: [Item]) -> [Item] {
        var next = Array(previous.prefix(count))
        for (index, item) in changed {
            if index < next.count {
                next[index] = item
            } else if index == next.count {
                next.append(item)
            }
            // A gap means we missed an update; the caller reloads the thread when counts don't match.
        }
        return next
    }
}

/// A streaming reply's new text, sent instead of the whole message (we ask with `append=1`):
/// `[index, length it had, new text]`. The length is in UTF-16 code units, as JavaScript counts.
struct TextAppend: Decodable, Sendable {
    var index: Int
    var from: Int
    var text: String

    init(from decoder: Decoder) throws {
        var item = try decoder.unkeyedContainer()
        index = try item.decode(Int.self)
        from = try item.decode(Int.self)
        text = try item.decode(String.self)
    }
}

struct ThreadPatch: Decodable, Sendable {
    var id: String
    var rest: ThreadInfo?
    var messages: ListPatch<Message>?
    /// Messages that only grew, from the same `messages` object.
    var appended: [TextAppend]?
    var activities: ListPatch<Activity>?

    private enum Keys: String, CodingKey { case id, rest, messages, activities }
    private struct Appends: Decodable { var appended: [TextAppend]? }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        id = try container.decode(String.self, forKey: .id)
        rest = try container.decodeIfPresent(ThreadInfo.self, forKey: .rest)
        messages = try container.decodeIfPresent(ListPatch<Message>.self, forKey: .messages)
        appended = try container.decodeIfPresent(Appends.self, forKey: .messages)?.appended
        activities = try container.decodeIfPresent(ListPatch<Activity>.self, forKey: .activities)
    }

    /// The thread after this patch, or nil when it can't be applied (another thread, a gap, or
    /// an append to text of another length).
    func apply(to thread: ChatThread) -> ChatThread? {
        guard thread.id == id else { return nil }
        var next = thread
        if let rest { next.info = rest }
        if let messages {
            next.messages = messages.apply(to: thread.messages)
            if next.messages.count != messages.count { return nil }
            for append in appended ?? [] {
                guard append.index < next.messages.count,
                      next.messages[append.index].text.utf16.count == append.from else { return nil }
                next.messages[append.index].text += append.text
            }
        }
        if let activities {
            next.activities = activities.apply(to: thread.activities)
            if next.activities.count != activities.count { return nil }
        }
        return next
    }
}

/// One event: only the keys that are present changed.
struct LiveUpdate: Decodable, Sendable {
    var threads: [ThreadSummary]?
    var projects: [ProjectSummary]?
    /// The agent defaults new threads start with (shared view settings).
    var ui: UiSettings?
    /// Present and null: no thread is open (or it was deleted).
    var thread: ChatThread??
    var threadPatch: ThreadPatch?

    private enum Keys: String, CodingKey { case threads, projects, ui, thread, threadPatch }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        threads = try container.decodeIfPresent([ThreadSummary].self, forKey: .threads)
        projects = try container.decodeIfPresent([ProjectSummary].self, forKey: .projects)
        ui = try? container.decodeIfPresent(UiSettings.self, forKey: .ui)
        if container.contains(.thread) {
            thread = .some(try container.decodeIfPresent(ChatThread.self, forKey: .thread))
        } else {
            thread = nil
        }
        threadPatch = try container.decodeIfPresent(ThreadPatch.self, forKey: .threadPatch)
    }
}

/// Splits a Server-Sent Events stream into the `data:` payloads of its events.
struct EventStreamParser {
    private var data: [String] = []

    /// Feed one line (without its newline). Returns an event's data when a blank line ends one.
    mutating func feed(_ line: String) -> String? {
        if line.isEmpty {
            defer { data = [] }
            return data.isEmpty ? nil : data.joined(separator: "\n")
        }
        if line.hasPrefix(":") { return nil } // A comment, e.g. the keepalive.
        if line.hasPrefix("data:") {
            var value = line.dropFirst(5)
            if value.first == " " { value = value.dropFirst() }
            data.append(String(value))
        }
        return nil
    }
}
