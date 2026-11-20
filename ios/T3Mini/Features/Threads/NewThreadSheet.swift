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
                // One section per computer: this one first, then each machine paired to it (its
                // threads run there; Hub.swift).
                ForEach(groups, id: \.title) { group in
                    Section(group.title) {
                        ForEach(group.projects) { project in
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

    /// "No project" first, then saved projects, most recent first.
    private var projects: [ProjectSummary] {
        model.projects.sorted { a, b in
            if (a.chats == true) != (b.chats == true) { return a.chats == true }
            return (a.lastActiveAt ?? "") > (b.lastActiveAt ?? "")
        }
    }

    /// The computer's own projects, then each machine's. With no machines, one "Project" list.
    private var groups: [(title: String, projects: [ProjectSummary])] {
        let mine = projects.filter { $0.machine == nil }
        guard !model.machines.isEmpty else { return [("Project", mine)] }
        return [("This computer", mine)] + model.machines.compactMap { machine in
            let theirs = projects.filter { Hub.machine(of: $0.path) == machine.id }
            return theirs.isEmpty ? nil : (machine.name, theirs)
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
    @AppStorage(SoundEffects.finishKey) private var finishSound = true
    @AppStorage(SoundEffects.finishNameKey) private var finishName = SoundEffects.Finish.chime.rawValue
    @AppStorage(SoundEffects.dictationKey) private var dictationSounds = true
    @AppStorage(AppTheme.key) private var theme = AppTheme.system.rawValue
    @AppStorage(DictationEngine.key) private var dictationEngine = DictationEngine.iphone.rawValue
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
                    Picker("Theme", selection: $theme) {
                        ForEach(AppTheme.allCases) { Text($0.label).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } header: {
                    Text("Appearance")
                } footer: {
                    Text("System follows your iPhone's light and dark setting.")
                }
                Section {
                    if DictationEngine.onDeviceAvailable {
                        Picker("Dictation", selection: $dictationEngine) {
                            ForEach(DictationEngine.allCases) { Text($0.label).tag($0.rawValue) }
                        }
                        .pickerStyle(.segmented)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                    }
                } header: {
                    Text("Dictation")
                } footer: {
                    if !DictationEngine.onDeviceAvailable {
                        Text("Dictation goes through your computer's Deepgram key. Dictating on the iPhone itself needs iOS 26.")
                    } else if dictationEngine == DictationEngine.computer.rawValue {
                        Text(model.dictationAvailable
                             ? (model.dictationLive
                                ? "Your voice goes to your computer, which turns it into text with Deepgram as you talk."
                                : "Your voice goes to your computer when you stop, and AssemblyAI turns it into clean, ready-to-send text.")
                             : "Your computer has no dictation key yet (t3 mini → Settings → Dictation), so the mic is off.")
                    } else {
                        Text("Apple's speech recognition, right on this iPhone: free, no key, and your voice never leaves the phone. The first time, iOS downloads your language's model.")
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
                    Toggle("When an agent finishes", isOn: $finishSound)
                    if finishSound {
                        Picker("Sound", selection: $finishName) {
                            ForEach(SoundEffects.Finish.allCases) { Text($0.label).tag($0.rawValue) }
                        }
                        .onChange(of: finishName) { _, name in
                            SoundEffects.playFinish(SoundEffects.Finish(rawValue: name), force: true)
                        }
                    }
                    Toggle("Dictation sounds", isOn: $dictationSounds)
                        .onChange(of: dictationSounds) { _, on in if on { SoundEffects.playCue(start: true, force: true) } }
                } header: {
                    Text("Sounds")
                } footer: {
                    Text("The same sounds as on your computer. They follow the silent switch.")
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
