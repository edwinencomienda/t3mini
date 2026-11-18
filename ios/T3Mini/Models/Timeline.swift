import Foundation

/// A thread laid out a turn at a time, like the web app (src/timeline.ts): your message, the
/// agent's work (its in-between notes and tool steps), then its final answer. A finished turn
/// folds its work into one line ("Worked for 21s · 6 steps"), leaving your message and the answer
/// in view; a turn in progress shows its work live.
struct Turn: Identifiable, Hashable {
    enum Work: Hashable, Identifiable {
        case note(Message)
        case step(Activity)
        var id: String {
            switch self {
            case .note(let message): "n:" + message.id
            case .step(let activity): "s:" + activity.id
            }
        }
    }

    let id: String
    var user: Message?
    var work: [Work] = []
    /// The agent's last message, once the turn has finished.
    var answer: Message?
    /// Images and other tool content from the folded notes, shown above the answer (they're
    /// results, not working detail).
    var blocks: [Block] = []
    var done = true
    var startedAt: String?
    var endedAt: String?
    /// The turn's to-do checklist: live while it runs, saved with your message once it ended.
    var todos: [Todo]?
    /// While it runs: status and sub-agent cards from its notes, kept in view while the work
    /// is folded (they're the progress you're following).
    var cards: [Block] = []

    /// Items the checklist ended with undone (0 without one).
    var unfinished: Int { todos?.filter { $0.status != "completed" }.count ?? 0 }
    /// How the latest run ended, when it ended early (stopped or failed): "Stopped after 12s".
    var outcome: ThreadStatus?

    var steps: Int {
        work.reduce(0) { count, item in if case .step = item { count + 1 } else { count } }
    }

    /// How long the turn took ("2m 10s"), once it's done and both ends are known.
    var elapsed: String? {
        guard done, let start = startedAt.flatMap(RelativeTime.parse), let end = endedAt.flatMap(RelativeTime.parse),
              end >= start else { return nil }
        return Self.duration(end.timeIntervalSince(start))
    }

    /// "Worked", "Stopped", or "Failed", with the word before the time.
    private var verb: (String, String) {
        switch outcome {
        case .interrupted: ("Stopped", "after")
        case .failed: ("Failed", "after")
        default: ("Worked", "for")
        }
    }

    /// "Worked for 21s · 6 steps" ("· 3 messages" for older turns without saved steps), like the
    /// web app's foldLabel. Shown for every finished turn of yours that has work to fold or a
    /// time; nil while it runs.
    var foldLabel: String? {
        guard done, user != nil || !work.isEmpty else { return nil }
        guard !work.isEmpty || elapsed != nil else { return nil }
        let (word, joiner) = verb
        var parts = [elapsed.map { "\(word) \(joiner) \($0)" } ?? word]
        let notes = work.count - steps
        if steps > 0 { parts.append("\(steps) step\(steps == 1 ? "" : "s")") }
        else if notes > 0 { parts.append("\(notes) message\(notes == 1 ? "" : "s")") }
        // Ended with its checklist unfinished: "2 of 6 left".
        if unfinished > 0, let total = todos?.count { parts.append("\(unfinished) of \(total) left") }
        return parts.joined(separator: " · ")
    }

    /// The line under the thread once its latest turn ends, like the web app (and Claude Code):
    /// "Worked for 24s · done 2:00 PM", with the day when it wasn't today.
    func finishLabel(now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let elapsed, let ended = endedAt.flatMap(RelativeTime.parse) else { return nil }
        let (word, joiner) = verb
        let clock = ended.formatted(date: .omitted, time: .shortened)
        let day = calendar.isDate(ended, inSameDayAs: now) ? "" : ended.formatted(.dateTime.month(.abbreviated).day()) + ", "
        let done = outcome == .interrupted || outcome == .failed ? "" : "done "
        return "\(word) \(joiner) \(elapsed) · \(done)\(day)\(clock)"
    }

    /// 3.8s, 21s, 2m 5s, 1h 4m.
    static func duration(_ seconds: TimeInterval) -> String {
        if seconds < 10 { return String(format: "%.1fs", seconds) }
        let total = Int(seconds.rounded())
        if total < 60 { return "\(total)s" }
        let minutes = total / 60
        if minutes < 60 { return total % 60 == 0 ? "\(minutes)m" : "\(minutes)m \(total % 60)s" }
        return minutes % 60 == 0 ? "\(minutes / 60)h" : "\(minutes / 60)h \(minutes % 60)m"
    }

    static func build(messages: [Message], activities: [Activity], running: Bool, completedAt: String?,
                      status: ThreadStatus = .completed, todos threadTodos: [Todo]? = nil) -> [Turn] {
        var turns: [Turn] = []
        for message in messages {
            if message.role == .user && message.report == nil || turns.isEmpty {
                let user = message.role == .user && message.report == nil ? message : nil
                turns.append(Turn(id: message.id, user: user, startedAt: user?.createdAt))
            }
            if message.role == .assistant || message.report != nil, turns.last?.user?.id != message.id {
                turns[turns.count - 1].work.append(.note(message))
            }
        }
        // Steps are only kept for the latest run: they belong to the last turn, in time order
        // among its notes.
        if !activities.isEmpty {
            if turns.isEmpty { turns.append(Turn(id: "work")) }
            let last = turns.count - 1
            var work = turns[last].work
            for activity in activities where activity.todo != true {
                work.append(.step(activity))
            }
            turns[last].work = work.sorted { time(of: $0) < time(of: $1) }
        }
        // The checklist, like the web (src/timeline.ts): the live one for the current run (only
        // if this run wrote one), otherwise the one saved with the turn's message.
        let wroteTodos = activities.contains { $0.todo == true }
        for index in turns.indices {
            let isLast = index == turns.count - 1
            let saved = isLast && running ? nil : turns[index].user?.todos
            let live = isLast && wroteTodos ? threadTodos : nil
            if let saved, !saved.isEmpty { turns[index].todos = saved }
            else if let live, !live.isEmpty { turns[index].todos = live }
        }
        for index in turns.indices {
            let isLast = index == turns.count - 1
            turns[index].done = !(isLast && running)
            if !turns[index].done {
                turns[index].cards = turns[index].work.flatMap { item -> [Block] in
                    guard case .note(let message) = item else { return [] }
                    return (message.blocks ?? []).filter {
                        if case .status = $0 { return true }
                        if case .delegation = $0 { return true }
                        return false
                    }
                }
            }
            guard turns[index].done else { continue }
            // The final answer: the last note with something to read.
            if let answerIndex = turns[index].work.lastIndex(where: {
                if case .note(let message) = $0 { return !message.text.isEmpty } else { return false }
            }), case .note(let answer) = turns[index].work[answerIndex] {
                turns[index].answer = answer
                turns[index].work.remove(at: answerIndex)
                // Work after the answer (rare) stays folded too.
            }
            // Pictures from the folded notes stay in view, above the answer.
            for item in turns[index].work {
                if case .note(let message) = item { turns[index].blocks += message.blocks ?? [] }
            }
            // The latest turn ends when the thread's run did (that's what the web app shows);
            // older ones at their answer.
            turns[index].endedAt = isLast ? (completedAt ?? turns[index].answer?.createdAt) : turns[index].answer?.createdAt
            if isLast, status == .interrupted || status == .failed { turns[index].outcome = status }
        }
        return turns
    }

    private static func time(of work: Work) -> String {
        switch work {
        case .note(let message): message.createdAt
        // A step saved before steps had times sorts after the notes it came with.
        case .step(let activity): activity.startedAt ?? "~"
        }
    }
}

/// The working line while a turn runs, like the web app (src/timeline.ts → liveNote): the agent's
/// latest note, but only finished text, so it doesn't change word by word while streaming. A note
/// counts as finished once anything comes after it; the last one only up to its last finished
/// paragraph (one followed by a blank line), never inside an open code block.
enum LiveText {
    static func latestNote(_ work: [Turn.Work]) -> String? {
        for (index, item) in work.enumerated().reversed() {
            guard case .note(let message) = item else { continue }
            let text = index == work.count - 1 ? finishedText(message.text) : message.text
            let line = noteLine(text)
            if !line.isEmpty { return line }
        }
        return nil
    }

    static func finishedText(_ text: String) -> String {
        guard let range = text.range(of: #"\n\s*\n"#, options: [.regularExpression, .backwards]) else { return "" }
        var done = String(text[..<range.lowerBound])
        // An unclosed code block: up to where it opened.
        let fences = done.components(separatedBy: "\n").filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }
        if fences.count % 2 == 1, let open = done.range(of: "```", options: .backwards) {
            done = String(done[..<open.lowerBound])
        }
        return done
    }

    /// A note's last paragraph as plain words on one line (Markdown marks, links, bullets dropped).
    static func noteLine(_ text: String) -> String {
        let paragraphs = text.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !$0.hasPrefix("```") }
        guard var paragraph = paragraphs.last else { return "" }
        paragraph = paragraph.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        paragraph = paragraph.replacingOccurrences(of: #"(?m)^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+"#, with: "", options: .regularExpression)
        paragraph = paragraph.replacingOccurrences(of: #"(\*\*|__|`|~~)"#, with: "", options: .regularExpression)
        return paragraph.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    }
}

extension Turn {
    /// What the working line says: the latest finished note, else the step running now, else
    /// Thinking… (Starting… before the agent has begun), and when that started.
    /// `working`: a step is running (the working character); otherwise it's thinking, like the web.
    func liveLine(starting: Bool, stepsOpen: Bool) -> (text: String, note: Bool, since: String?, working: Bool) {
        var running: Activity?
        for item in work.reversed() {
            if case .step(let activity) = item, activity.status == "running" { running = activity; break }
        }
        if !stepsOpen, let note = LiveText.latestNote(work) { return (note, true, startedAt, running != nil) }
        if let running { return (running.line, false, running.startedAt ?? startedAt, true) }
        return (starting ? "Starting…" : "Thinking…", false, startedAt, false)
    }
}

/// "9:36 AM" today, "Yesterday 9:36 AM", else "11/16 9:36 AM", like the web app's message times.
enum MessageTime {
    static func label(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = RelativeTime.parse(iso) else { return "" }
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday \(time)"
        }
        let day = date.formatted(.dateTime.month(.defaultDigits).day())
        return "\(day) \(time)"
    }
}
