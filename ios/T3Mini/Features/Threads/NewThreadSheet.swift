import SwiftUI

/// Pick a project and an agent, then open the new thread.
struct NewThreadSheet: View {
    let created: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var provider: Provider = .claude
    @State private var projectPath: String?
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Agent") {
                    Picker("Agent", selection: $provider) {
                        ForEach(Provider.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                Section("Project") {
                    ForEach(projects) { project in
                        Button {
                            projectPath = project.path
                        } label: {
                            HStack(spacing: 12) {
                                ProjectAvatar(name: project.displayName, project: project, size: 32)
                                Text(project.displayName).foregroundStyle(.primary)
                                Spacer()
                                if projectPath == project.path {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .navigationTitle("New thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working { ProgressView() } else {
                        Button("Start") { Task { await start() } }.disabled(projectPath == nil)
                    }
                }
            }
            .onAppear {
                provider = model.defaultProvider
                projectPath = model.defaultProject?.path ?? projects.first?.path
            }
        }
    }

    /// Saved projects, most recent first, with "No project" last.
    private var projects: [ProjectSummary] {
        model.projects.sorted { a, b in
            if (a.chats == true) != (b.chats == true) { return b.chats == true }
            return (a.lastActiveAt ?? "") > (b.lastActiveAt ?? "")
        }
    }

    private func start() async {
        working = true
        problem = nil
        defer { working = false }
        do {
            let project = model.projects.first { $0.path == projectPath }
            if let id = try await model.createThread(provider: provider, project: project) {
                dismiss()
                created(id)
            }
        } catch {
            problem = error.localizedDescription
        }
    }
}

struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        NavigationStack {
            Form {
                if let connection = model.connection {
                    Section("Connected to") {
                        LabeledContent("Computer", value: connection.displayHost)
                        LabeledContent("Paired", value: connection.pairedAt.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                Section {
                    Button("Disconnect this iPhone", role: .destructive) { confirming = true }
                } footer: {
                    Text("Also remove it on your computer (Settings → Devices) to end its access there.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Disconnect from this computer?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Disconnect", role: .destructive) {
                    model.disconnect()
                    dismiss()
                }
            }
        }
    }
}
