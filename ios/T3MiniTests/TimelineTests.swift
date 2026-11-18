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
        #expect(WorkingRow.counter(42) == "42s")
        #expect(WorkingRow.counter(185) == "3m 5s")
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
}
