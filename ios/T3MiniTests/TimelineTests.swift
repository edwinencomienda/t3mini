import Foundation
import Testing
@testable import T3Mini

struct TimelineTests {
    func message(_ id: String, _ role: Message.Role, _ at: String, _ text: String = "text") -> Message {
        Message(id: id, role: role, text: text, createdAt: at)
    }
    func step(_ id: String, _ at: String) -> Activity {
        Activity(id: id, label: "Run", summary: "bun test", status: "completed", startedAt: at)
    }

    @Test func foldsAFinishedTurnsWorkAndKeepsTheAnswer() {
        let turns = Turn.build(
            messages: [
                message("u1", .user, "2026-11-18T10:00:00.000Z"),
                message("a1", .assistant, "2026-11-18T10:00:02.000Z", "Looking…"),
                message("a2", .assistant, "2026-11-18T10:00:21.000Z", "Done!"),
                message("u2", .user, "2026-11-18T10:05:00.000Z"),
                message("a3", .assistant, "2026-11-18T10:05:03.000Z", "Working on it"),
            ],
            activities: [step("s1", "2026-11-18T10:05:01.000Z"), step("s2", "2026-11-18T10:05:04.000Z")],
            running: true, completedAt: nil)
        #expect(turns.count == 2)
        #expect(turns[0].user?.id == "u1")
        #expect(turns[0].answer?.id == "a2")
        #expect(turns[0].work.map(\.id) == ["n:a1"])
        #expect(turns[0].foldLabel == "Worked for 21s · 1 message")
        // The running turn shows its work live, in time order, with no answer yet.
        #expect(turns[1].done == false)
        #expect(turns[1].answer == nil)
        #expect(turns[1].work.map(\.id) == ["s:s1", "n:a3", "s:s2"])
        #expect(turns[1].foldLabel == nil)
    }

    @Test func countsStepsAndUsesTheThreadsEndForTheLastTurn() {
        let turns = Turn.build(
            messages: [message("u1", .user, "2026-11-18T10:00:00.000Z"), message("a1", .assistant, "2026-11-18T10:02:05.000Z")],
            activities: [step("s1", "2026-11-18T10:00:01.000Z"), step("s2", "2026-11-18T10:01:00.000Z")],
            running: false, completedAt: "2026-11-18T10:02:05.000Z")
        #expect(turns[0].steps == 2)
        #expect(turns[0].foldLabel == "Worked for 2m 5s · 2 steps")
    }

    @Test func showsTheTimeEvenWithNothingFoldedAndHowARunEnded() {
        let quick = Turn.build(
            messages: [message("u1", .user, "2026-11-18T10:00:00.000Z"), message("a1", .assistant, "2026-11-18T10:00:24.000Z")],
            activities: [], running: false, completedAt: "2026-11-18T10:00:24.000Z")
        #expect(quick[0].work.isEmpty)
        #expect(quick[0].foldLabel == "Worked for 24s")
        #expect(quick[0].finishLabel()?.hasPrefix("Worked for 24s · done ") == true)
        let stopped = Turn.build(
            messages: [message("u1", .user, "2026-11-18T10:00:00.000Z"), message("a1", .assistant, "2026-11-18T10:00:05.000Z", "Hm"),
                       message("a2", .assistant, "2026-11-18T10:00:12.000Z", "Partial")],
            activities: [], running: false, completedAt: "2026-11-18T10:00:12.000Z", status: .interrupted)
        #expect(stopped[0].foldLabel == "Stopped after 12s · 1 message")
        #expect(stopped[0].finishLabel()?.hasPrefix("Stopped after 12s · ") == true)
        #expect(LiveLine.counter(42) == "42s")
        #expect(LiveLine.counter(185) == "3m 5s")
    }

    @Test func durations() {
        #expect(Turn.duration(3.84) == "3.8s")
        #expect(Turn.duration(21) == "21s")
        #expect(Turn.duration(125) == "2m 5s")
        #expect(Turn.duration(3600 + 240) == "1h 4m")
    }

    @Test func messageTimes() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO8601DateFormatter().date(from: "2026-11-18T12:00:00Z")!
        #expect(!MessageTime.label("2026-11-18T09:36:00.000Z", now: now, calendar: calendar).contains("/"))
        #expect(MessageTime.label("2026-11-17T09:36:00.000Z", now: now, calendar: calendar).hasPrefix("Yesterday"))
        #expect(MessageTime.label("2026-11-16T09:36:00.000Z", now: now, calendar: calendar).contains("/"))
    }

    @Test func diagramsForThePhone() {
        #expect(DiagramRenderer.phoneFriendly("flowchart LR\n  a --> b") == "flowchart TB\n  a --> b")
        #expect(DiagramRenderer.phoneFriendly("%% note\ngraph RL;\na-->b") == "%% note\ngraph TB;\na-->b")
        #expect(DiagramRenderer.phoneFriendly("sequenceDiagram\nA->>B: LR") == "sequenceDiagram\nA->>B: LR")
        let size = DiagramRenderer.size(of: #"<svg width="100%" viewBox="-8 -8 316.5 120" style="max-width: 316px">"#)
        #expect(size?.width == 316.5)
        #expect(size?.height == 120)
        #expect(DiagramRenderer.size(of: "<svg>") == nil)
    }

    @Test func decodesDiagramBlocks() throws {
        let json = #"{"type":"diagram","source":"graph TD; a-->b","title":"Flow"}"#
        let block = try JSONDecoder().decode(Block.self, from: Data(json.utf8))
        #expect(block == .diagram(source: "graph TD; a-->b", title: "Flow"))
    }

    @MainActor
    @Test(.timeLimit(.minutes(1))) func drawsARealDiagram() async throws {
        let drawing = try await DiagramRenderer.shared.draw("flowchart LR\n  a[Phone] --> b[Computer]", dark: true)
        #expect(drawing.svg.hasPrefix("<svg"))
        #expect(drawing.svg.contains("Computer"))
        #expect(drawing.height > 100 && drawing.width < 250) // stacked top to bottom (side by side: ~300 × 60)
        #expect(DiagramRenderer.shared.cached("flowchart LR\n  a[Phone] --> b[Computer]", dark: true) == drawing)
        await #expect(throws: (any Error).self) { try await DiagramRenderer.shared.draw("flowchart TB\n  a -->", dark: false) }
    }

    @Test func liveActivityLinksAndText() throws {
        let url = try #require(ThreadLink.url(for: "thr_abc-123"))
        #expect(url.absoluteString == "t3mini://thread/thr_abc-123")
        #expect(ThreadLink.threadId(from: url) == "thr_abc-123")
        #expect(ThreadLink.threadId(from: URL(string: "t3mini://thread/../x")!) == nil)
        #expect(ThreadLink.threadId(from: URL(string: "https://example.com/thread/abc")!) == nil)
        // The computer's update (src/server/live-activities.ts) decodes as the widget reads it.
        let json = #"{"status":"done","steps":12,"startedAt":1000,"endedAt":1130}"#
        let state = try JSONDecoder().decode(ThreadActivityAttributes.ContentState.self, from: Data(json.utf8))
        #expect(state.detail == "Done in 2m 10s · 12 steps")
        #expect(ThreadActivityAttributes.ContentState(status: "working", steps: 1, startedAt: 0).detail == "Working · 1 step")
    }

    @Test func workingLineLikeTheWeb() {
        // Only finished text: the last note up to its last finished paragraph.
        #expect(LiveText.finishedText("Looking at the tests.\n\nNow I'll run") == "Looking at the tests.")
        #expect(LiveText.finishedText("Still typing") == "")
        #expect(LiveText.noteLine("Intro\n\n- **Checking** the [docs](https://example.com) and `tests`") == "Checking the docs and tests")
        let note = Message(id: "a1", role: .assistant, text: "I'll check the branch first.\n\nThen", createdAt: "2026-11-18T10:00:01.000Z")
        let step = Activity(id: "s1", label: "Run", summary: "git status", status: "running", startedAt: "2026-11-18T10:00:02.000Z")
        // The note is the latest item and still streaming: only its finished paragraph shows.
        var turn = Turn(id: "u1", work: [.step(step), .note(note)], done: false, startedAt: "2026-11-18T10:00:00.000Z")
        #expect(turn.liveLine(starting: false, stepsOpen: false).text == "I'll check the branch first.")
        // A step came after it: the note is finished, so its last paragraph shows.
        turn.work = [.note(note), .step(step)]
        #expect(turn.liveLine(starting: false, stepsOpen: false).text == "Then")
        #expect(turn.liveLine(starting: false, stepsOpen: true).text == "Run · git status")
        turn.work = [.step(step)]
        #expect(turn.liveLine(starting: false, stepsOpen: false).text == "Run · git status")
        #expect(turn.liveLine(starting: false, stepsOpen: false).working)
        turn.work = []
        #expect(turn.liveLine(starting: true, stepsOpen: false).text == "Starting…")
        #expect(!turn.liveLine(starting: true, stepsOpen: false).working)
    }

    @Test func diskCacheKeepsAndTrims() throws {
        let cache = DiskCache(scope: "test-" + UUID().uuidString, limit: 250)
        defer { cache.removeAll() }
        cache.write("upload:a.png", Data(repeating: 1, count: 100))
        #expect(cache.read("upload:a.png")?.count == 100)
        // Names on disk are hashes, not the keys.
        let names = try FileManager.default.contentsOfDirectory(atPath: cache.folder.path)
        #expect(names.allSatisfy { !$0.contains("upload") && $0.count == 64 })
        Thread.sleep(forTimeInterval: 0.02)
        cache.write("upload:b.png", Data(repeating: 2, count: 100))
        Thread.sleep(forTimeInterval: 0.02)
        cache.write("upload:c.png", Data(repeating: 3, count: 100))
        cache.trim()
        #expect(cache.read("upload:a.png") == nil) // oldest went past the limit
        #expect(cache.read("upload:c.png")?.count == 100)
        cache.removeAll()
        #expect(cache.read("upload:c.png") == nil)
    }

    @MainActor
    @Test func mascotsAreBundled() {
        for name in ["claude-working", "claude-thinking", "claude-celebrating", "codex-working", "codex-thinking", "codex-celebrating"] {
            #expect(Bundle.main.url(forResource: name, withExtension: "gif", subdirectory: "mascots") != nil, "\(name)")
        }
    }

    @Test func checklistLikeTheWeb() {
        let todos = [Todo(id: "1", text: "Read", status: "completed"), Todo(id: "2", text: "Write", status: "in_progress"),
                     Todo(id: "3", text: "Test", status: "pending")]
        let todoStep = Activity(id: "t", label: "Todo", status: "completed", todo: true, startedAt: "2026-11-18T10:00:01.000Z")
        let user = Message(id: "u1", role: .user, text: "go", createdAt: "2026-11-18T10:00:00.000Z")
        // Running: the live checklist (this run wrote one).
        let running = Turn.build(messages: [user], activities: [todoStep], running: true, completedAt: nil, todos: todos)
        #expect(running[0].todos?.count == 3)
        // Ended, saved with the message, two left: the fold says so.
        var saved = user
        saved.todos = todos
        let reply = Message(id: "a1", role: .assistant, text: "Partly done", createdAt: "2026-11-18T10:00:30.000Z")
        let ended = Turn.build(messages: [saved, reply], activities: [todoStep], running: false,
                               completedAt: "2026-11-18T10:00:30.000Z", todos: todos)
        #expect(ended[0].unfinished == 2)
        #expect(ended[0].foldLabel == "Worked for 30s · 2 of 3 left")
        // No checklist written this run: none shown.
        #expect(Turn.build(messages: [user], activities: [], running: true, completedAt: nil, todos: todos)[0].todos == nil)
    }

    @Test func soundsRenderLikeTheWeb() {
        for sound in SoundEffects.Finish.allCases {
            let samples = Synth.finish(sound)
            #expect(samples.count > 4_000)
            #expect(samples.map(abs).max()! > 0.02 && samples.map(abs).max()! < 1) // audible, never clipping
        }
        let cue = Synth.cue(start: true)
        #expect(Double(cue.count) / Synth.rate < 0.4) // short, out of the way while speaking
        let wav = Synth.wav(cue)
        #expect(wav.prefix(4) == Data("RIFF".utf8) && wav.count == 44 + cue.count * 2)
    }
}
