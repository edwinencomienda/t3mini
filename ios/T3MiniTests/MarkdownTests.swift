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
            .status(title: "Pushed", status: "done", detail: nil, url: nil),
            .diagram(source: "flowchart LR", title: "Flow"),
            .html(id: "p.html", title: "Chart", libraries: ["chart.js"]),
            .other(type: "future-thing", title: nil),
        ])
    }
}
