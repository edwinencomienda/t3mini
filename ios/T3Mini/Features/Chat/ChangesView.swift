import SwiftUI

/// The project's uncommitted changes, like the web app's Changes panel (GET /api/threads/:id/diff):
/// tracked files against HEAD plus new files, each with its + / − counts; tap one for its lines.
/// The computer caps big change sets (the first 200 files; huge files show counts only).
struct ChangesView: View {
    let threadId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var result: DiffResult?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Group {
                if let result {
                    if !result.repo {
                        ContentUnavailableView("Not a git repository", systemImage: "folder",
                                               description: Text("This thread's folder isn't tracked by git."))
                    } else if result.files.isEmpty {
                        ContentUnavailableView("No changes", systemImage: "checkmark.circle",
                                               description: Text("Nothing uncommitted in this project."))
                    } else {
                        fileList(result)
                    }
                } else if let problem {
                    ContentUnavailableView("Couldn’t load the changes", systemImage: "exclamationmark.triangle",
                                           description: Text(problem))
                } else {
                    ProgressView("Loading changes…")
                }
            }
            .navigationTitle("Changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Refresh")
                }
            }
            .navigationDestination(for: DiffFile.self) { file in FileDiffView(file: file) }
            .task { await load() }
        }
    }

    private func fileList(_ result: DiffResult) -> some View {
        let additions = result.files.reduce(0) { $0 + $1.additions }
        let deletions = result.files.reduce(0) { $0 + $1.deletions }
        return List {
            Section {
                ForEach(result.files) { file in
                    NavigationLink(value: file) { FileRow(file: file) }
                }
            } header: {
                HStack(spacing: 6) {
                    Text("\(result.totalFiles) file\(result.totalFiles == 1 ? "" : "s")")
                    Text("+\(additions)").foregroundStyle(.green)
                    Text("−\(deletions)").foregroundStyle(.red)
                }
                .font(.footnote.monospacedDigit())
            } footer: {
                if result.truncated {
                    Text("Showing \(result.files.count) of \(result.totalFiles) files.")
                }
            }
        }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            result = try await model.diff(of: threadId)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}

private struct FileRow: View {
    let file: DiffFile

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text((file.path as NSString).lastPathComponent).font(.subheadline.weight(.medium)).lineLimit(1)
                let folder = (file.path as NSString).deletingLastPathComponent
                if let old = file.oldPath {
                    Text("from \(old)").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                } else if !folder.isEmpty {
                    Text(folder).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: 6)
            if file.binary {
                Text("Binary").font(.caption).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 4) {
                    Text("+\(file.additions)").foregroundStyle(.green)
                    Text("−\(file.deletions)").foregroundStyle(.red)
                }
                .font(.caption.monospacedDigit())
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch file.status {
        case "added": "plus.square"
        case "deleted": "minus.square"
        case "renamed": "arrow.right.square"
        default: "pencil.line"
        }
    }

    private var color: Color {
        switch file.status {
        case "added": .green
        case "deleted": .red
        case "renamed": .blue
        default: .orange
        }
    }
}

/// One file's changes: its hunks, added lines green, removed lines red, with line numbers.
/// Long lines scroll sideways together, like a code viewer; lines draw lazily for big files.
private struct FileDiffView: View {
    let file: DiffFile

    var body: some View {
        Group {
            if file.binary {
                ContentUnavailableView("Binary file", systemImage: "doc", description: Text("Its contents can't be shown as text."))
            } else if file.tooLarge == true || file.hunks.isEmpty {
                ContentUnavailableView(file.tooLarge == true ? "Too large to show" : "No line changes",
                                       systemImage: "doc.text",
                                       description: Text("+\(file.additions) −\(file.deletions)"))
            } else {
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                            Text(hunk.header)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.appSurface)
                            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                                LineRow(line: line)
                            }
                        }
                    }
                    .padding(.bottom, 24)
                }
            }
        }
        .navigationTitle((file.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct LineRow: View {
    let line: DiffLine

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Text(line.old.map(String.init) ?? "").frame(width: 38, alignment: .trailing)
            Text(line.new.map(String.init) ?? "").frame(width: 38, alignment: .trailing)
            Text(line.type == "add" ? "+" : line.type == "del" ? "−" : " ").frame(width: 18)
            Text(line.text.isEmpty ? " " : line.text)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.trailing, 12)
        }
        .font(.caption.monospaced())
        .foregroundStyle(line.type == "ctx" ? Color.secondary : Color.primary)
        .padding(.vertical, 1)
        .background(line.type == "add" ? Color.green.opacity(0.14) : line.type == "del" ? Color.red.opacity(0.14) : Color.clear)
    }
}
