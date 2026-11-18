import SwiftUI

/// Pick a project and an agent, then open the new thread.
struct NewThreadSheet: View {
    let created: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var choice = AgentChoice(provider: .claude, model: "", effort: "", serviceTier: "",
                                            permissionMode: PermissionMode.defaultValue)
    @State private var projectPath: String?
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
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
                AgentSettingsForm(choice: $choice, cwd: projectPath)
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
                choice = model.defaultChoice(for: model.defaultProvider)
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
            if let id = try await model.createThread(project: project, choice: choice) {
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
                    Toggle("Notify me", isOn: Binding(
                        get: { model.push == .on || model.push == .notSetUp },
                        set: { on in Task { on ? await model.enablePush() : await model.disablePush() } }))
                        .disabled(model.push == .denied)
                    if model.push == .on || model.push == .notSetUp {
                        Button("Send a test") { Task { await model.testPush() } }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    switch model.push {
                    case .denied:
                        Text("Notifications are off for t3 mini in iOS Settings → Notifications.")
                    case .notSetUp:
                        Text("This iPhone is ready, but the computer has no Apple push key yet.")
                    default:
                        Text(model.pushProblem ?? "Get a notification when a thread finishes, fails, or needs you. It says only what happened; the thread's name shows when you open it.")
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
