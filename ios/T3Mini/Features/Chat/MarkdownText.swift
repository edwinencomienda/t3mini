import SwiftUI

/// Enough Markdown for agent replies: paragraphs with inline styling (bold, code, links), headings,
/// lists, quotes, fenced code blocks, and tables.
struct MarkdownText: View {
    let text: String

    /// Space between lines inside a paragraph, on top of the font's own: reads like the web app.
    static let lineSpacing: CGFloat = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let line):
            Text(Self.inline(line))
                .lineSpacing(Self.lineSpacing)
        case .heading(let level, let line):
            Text(Self.inline(line))
                .font(level <= 2 ? .headline : .callout.weight(.semibold))
                .padding(.top, 4)
        case .bullet(let marker, let line, let depth):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker)
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 14, alignment: .trailing)
                Text(Self.inline(line))
                    .lineSpacing(Self.lineSpacing)
            }
            .padding(.leading, CGFloat(depth) * 16)
        case .quote(let line):
            Text(Self.inline(line))
                .lineSpacing(Self.lineSpacing)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 3) }
        case .code(let code, let language):
            CodeBlock(code: code, language: language)
        case .table(let table):
            MarkdownTable(table: table)
        case .rule:
            Divider()
        }
    }

    static func inline(_ line: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: line, options: options)) ?? AttributedString(line)
    }
}

/// A fenced code block, like ChatGPT's: the language and a copy button on top, the code below
/// (scrolls sideways instead of wrapping).
struct CodeBlock: View {
    let code: String
    let language: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "Code" : language)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.footnote)
                }
                .buttonStyle(.borderless)
                .tint(.secondary)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 4)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .lineSpacing(4)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
                    .padding(.top, 4)
            }
        }
        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 16))
    }
}

/// A Markdown table: a bold header row, then rows with light stripes. Each column is as wide as
/// its longest visible text (link targets don't count), between 64 and 260 points; longer text
/// wraps. A table wider than the screen scrolls sideways.
struct MarkdownTable: View {
    let table: MarkdownBlock.Table

    var body: some View {
        let widths = table.columnWidths()
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                row(table.header, widths: widths, header: true)
                    .background(Color(.secondarySystemFill))
                ForEach(table.rows.indices, id: \.self) { index in
                    Divider()
                    row(table.rows[index], widths: widths, header: false)
                        .background(index.isMultiple(of: 2) ? Color.clear : Color(.secondarySystemFill).opacity(0.35))
                }
            }
            .fixedSize()
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.separator)))
            .clipShape(.rect(cornerRadius: 12))
            .padding(1)
        }
    }

    private func row(_ cells: [String], widths: [CGFloat], header: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(widths.indices, id: \.self) { column in
                let alignment = column < table.alignments.count ? table.alignments[column] : .leading
                Text(MarkdownText.inline(column < cells.count ? cells[column] : ""))
                    .font(header ? .footnote.weight(.semibold) : .footnote)
                    .lineSpacing(3)
                    .multilineTextAlignment(alignment == .trailing ? .trailing : alignment == .center ? .center : .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(width: widths[column], alignment: Alignment(horizontal: alignment, vertical: .top))
                    .overlay(alignment: .trailing) {
                        if column < widths.count - 1 { Rectangle().fill(Color(.separator).opacity(0.6)).frame(width: 0.5) }
                    }
            }
        }
    }
}

extension MarkdownBlock.Table {
    /// Points per column: the longest visible text in it (about 8 points a character at
    /// footnote size, plus padding), kept between 60 and 240.
    func columnWidths() -> [CGFloat] {
        header.indices.map { column in
            let longest = ([header] + rows)
                .map { column < $0.count ? Self.visibleText($0[column]).count : 0 }
                .max() ?? 0
            return min(max(CGFloat(longest) * 7.5 + 26, 60), 240)
        }
    }

    /// What a cell shows: link text without its target, without ** and ` marks.
    static func visibleText(_ cell: String) -> String {
        cell.replacing(/\[([^\]]*)\]\([^)]*\)/) { String($0.1) }
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
    }
}

enum MarkdownBlock: Equatable {
    case paragraph(String)
    case heading(Int, String)
    /// marker ("•" or "2."), text, nesting depth
    case bullet(String, String, Int)
    case quote(String)
    /// The code and its fence's language ("swift" in ```swift), or "".
    case code(String, language: String)
    case table(Table)
    case rule

    struct Table: Equatable {
        var header: [String]
        var alignments: [HorizontalAlignment]
        var rows: [[String]]

        static func == (a: Table, b: Table) -> Bool {
            a.header == b.header && a.rows == b.rows && a.alignments.map(String.init(describing:)) == b.alignments.map(String.init(describing:))
        }
    }

    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var code: [String]?
        var language = ""
        let lines = text.components(separatedBy: "\n")
        var index = 0

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }

        while index < lines.count {
            let raw = lines[index]
            let line = raw.trimmingCharacters(in: .whitespaces)
            index += 1
            if line.hasPrefix("```") {
                if let lines = code {
                    blocks.append(.code(lines.joined(separator: "\n"), language: language))
                    code = nil
                } else {
                    flush()
                    code = []
                    language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                }
                continue
            }
            if code != nil {
                code?.append(raw)
                continue
            }
            // A table: a row of cells, then a separator row like |---|:--:|.
            if line.hasPrefix("|"), index < lines.count, let alignments = separator(lines[index]) {
                flush()
                let header = cells(line)
                index += 1
                var rows: [[String]] = []
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespaces)
                    guard next.hasPrefix("|") else { break }
                    rows.append(cells(next))
                    index += 1
                }
                let columns = header.count
                blocks.append(.table(Table(
                    header: header,
                    alignments: (0..<columns).map { $0 < alignments.count ? alignments[$0] : .leading },
                    rows: rows)))
                continue
            }
            let indent = raw.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
            if line.isEmpty {
                flush()
            } else if line.firstMatch(of: /^(-{3,}|\*{3,}|_{3,})$/) != nil {
                flush()
                blocks.append(.rule)
            } else if let heading = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) {
                flush()
                blocks.append(.heading(heading.1.count, String(heading.2)))
            } else if let item = line.firstMatch(of: /^[-*+]\s+(.*)$/) {
                flush()
                blocks.append(.bullet("•", String(item.1), min(indent / 2, 4)))
            } else if let item = line.firstMatch(of: /^(\d+[.)])\s+(.*)$/) {
                flush()
                blocks.append(.bullet(String(item.1), String(item.2), min(indent / 3, 4)))
            } else if let quote = line.firstMatch(of: /^>\s?(.*)$/) {
                flush()
                blocks.append(.quote(String(quote.1)))
            } else {
                paragraph.append(line)
            }
        }
        if let lines = code { blocks.append(.code(lines.joined(separator: "\n"), language: language)) }
        flush()
        return blocks
    }

    /// "| a | b |" → ["a", "b"]. A `\|` inside a cell stays a pipe.
    static func cells(_ line: String) -> [String] {
        var body = line.trimmingCharacters(in: .whitespaces)
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") && !body.hasSuffix("\\|") { body.removeLast() }
        let placeholder = "\u{0}"
        return body.replacingOccurrences(of: "\\|", with: placeholder)
            .components(separatedBy: "|")
            .map { $0.replacingOccurrences(of: placeholder, with: "|").trimmingCharacters(in: .whitespaces) }
    }

    /// The column alignments when the line is a table separator ("|:---|--:|"), else nil.
    static func separator(_ line: String) -> [HorizontalAlignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.contains("|") || trimmed.hasPrefix(":") || trimmed.hasPrefix("-") else { return nil }
        let parts = cells(trimmed)
        guard !parts.isEmpty, parts.allSatisfy({ $0.firstMatch(of: /^:?-{1,}:?$/) != nil }) else { return nil }
        return parts.map { part in
            switch (part.hasPrefix(":"), part.hasSuffix(":")) {
            case (true, true): .center
            case (false, true): .trailing
            default: .leading
            }
        }
    }
}
