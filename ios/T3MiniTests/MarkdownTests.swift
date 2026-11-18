import Foundation
import SwiftUI
import Testing
@testable import T3Mini

struct MarkdownTests {
    @Test func splitsBlocks() {
        let blocks = MarkdownBlock.parse("""
        # Done
        Fixed **two** bugs:
        - one
        2. two

        > note
        ```swift
        let x = 1
          indented
        ```
        """)
        #expect(blocks == [
            .heading(1, "Done"),
            .paragraph("Fixed **two** bugs:"),
            .bullet("•", "one", 0),
            .bullet("2.", "two", 0),
            .quote("note"),
            .code("let x = 1\n  indented", language: "swift"),
        ])
    }

    @Test func unclosedCodeBlockStillShows() {
        #expect(MarkdownBlock.parse("```\nstreaming") == [.code("streaming", language: "")])
    }

    @Test func parsesTables() {
        let blocks = MarkdownBlock.parse("""
        Results:
        | Name | Count | Note |
        |:-----|------:|:----:|
        | **a** | 1 | x \\| y |
        | b | 22 |
        After
        """)
        guard blocks.count == 3, case .table(let table) = blocks[1] else {
            Issue.record("expected paragraph, table, paragraph: \(blocks)")
            return
        }
        #expect(table.header == ["Name", "Count", "Note"])
        #expect(table.rows == [["**a**", "1", "x | y"], ["b", "22"]])
        #expect(table.alignments.map(String.init(describing:)) == [HorizontalAlignment.leading, .trailing, .center].map(String.init(describing:)))
        #expect(blocks[2] == .paragraph("After"))
    }

    @Test func pipeLinesWithoutSeparatorAreText() {
        #expect(MarkdownBlock.parse("| not a table |") == [.paragraph("| not a table |")])
    }

    @Test func nestedBulletsAndRules() {
        #expect(MarkdownBlock.parse("- a\n  - b\n---") == [.bullet("•", "a", 0), .bullet("•", "b", 1), .rule])
    }

    @Test func tableColumnsFitTheirVisibleText() {
        let table = MarkdownBlock.Table(
            header: ["#", "Title"], alignments: [.leading, .leading],
            rows: [["[#3446](https://github.com/example/app/pull/3446)", String(repeating: "word ", count: 30)]])
        let widths = table.columnWidths()
        #expect(MarkdownBlock.Table.visibleText("[#3446](https://example.com/x) **b**") == "#3446 b")
        #expect(widths[0] < 90) // "#3446", not the whole link
        #expect(widths[1] == 240) // long text wraps at the cap
    }

    @Test func decodesToolBlocks() throws {
        let json = #"[{"type":"image","id":"abc.png","caption":"Login page"},{"type":"status","id":"s","kind":"push","status":"done","title":"Pushed","startedAt":"x"},{"type":"diagram","source":"flowchart LR","title":"Flow"},{"type":"html","id":"p.html","title":"Chart","libraries":["chart.js"]},{"type":"future-thing"}]"#
        let blocks = try JSONDecoder().decode([Block].self, from: Data(json.utf8))
        #expect(blocks == [
            .image(id: "abc.png", caption: "Login page"),
            .status(StatusInfo(kind: "push", status: "done", title: "Pushed", startedAt: "x")),
            .diagram(source: "flowchart LR", title: "Flow"),
            .html(id: "p.html", title: "Chart", libraries: ["chart.js"]),
            .other(type: "future-thing", title: nil),
        ])
    }

    @Test func mermaidFencesBecomeDiagramsOnceClosed() {
        #expect(MarkdownBlock.parse("Look:\n```mermaid\ngraph TD; a-->b\n```") == [.paragraph("Look:"), .diagram("graph TD; a-->b")])
        // Still streaming (no closing fence): code for now.
        #expect(MarkdownBlock.parse("```mermaid\ngraph TD; a-->") == [.code("graph TD; a-->", language: "mermaid")])
        #expect(MarkdownBlock.parse("```swift\nlet a = 1\n```") == [.code("let a = 1", language: "swift")])
    }

    @Test func decodesFullToolCards() throws {
        let json = #"[{"type":"status","id":"s","kind":"push","status":"done","title":"Pushed","stages":["Commit","Push"],"stage":"Push","commits":[{"sha":"abc1234def","message":"Fix it"}],"url":"https://github.com/example/app","startedAt":"2026-11-18T10:00:00Z","endedAt":"2026-11-18T10:00:12Z"},{"type":"delegation","id":"t2","title":"Write tests","agent":"codex","access":"edit","background":false,"status":"running","step":"Run · bun test","todos":{"done":1,"total":3},"files":["src/a.ts"],"startedAt":"x"},{"type":"video","id":"v.mp4","caption":"Demo"},{"type":"audio","id":"a.m4a"}]"#
        let blocks = try JSONDecoder().decode([Block].self, from: Data(json.utf8))
        guard case .status(let status) = blocks[0], case .delegation(let sub) = blocks[1] else {
            Issue.record("wrong kinds"); return
        }
        #expect(status.stages == ["Commit", "Push"] && status.commits?.first?.sha == "abc1234def")
        #expect(sub.agent == .codex && sub.todos?.total == 3 && sub.files == ["src/a.ts"] && sub.id == "t2")
        #expect(blocks[2] == .video(id: "v.mp4", caption: "Demo"))
        #expect(blocks[3] == .audio(id: "a.m4a", caption: nil))
    }
}
