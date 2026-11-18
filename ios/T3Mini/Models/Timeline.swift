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
                      status: ThreadStatus = .completed) -> [Turn] {
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
        for index in turns.indices {
            let isLast = index == turns.count - 1
            turns[index].done = !(isLast && running)
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
