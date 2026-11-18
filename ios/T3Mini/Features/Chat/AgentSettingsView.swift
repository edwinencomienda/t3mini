import SwiftUI

/// Choosing the agent and how it runs: Claude or Codex, the model, the reasoning level, the speed
/// (Codex models that offer one), and the permission. Every option is a full row with its
/// description, instead of a small dropdown. The models come from the computer (GET /api/models).
struct AgentSettingsForm: View {
    @Binding var choice: AgentChoice
    let cwd: String?
    @Environment(AppModel.self) private var model
    @State private var models: [ModelOption] = []
    @State private var loading = false

    private var currentModel: ModelOption? {
        models.first { $0.id == choice.model } ?? models.first { $0.isDefault == true || $0.id == "default" }
    }

    var body: some View {
        Group { sections }
            .task(id: "\(choice.provider.rawValue)|\(cwd ?? "")") {
                models = model.cachedModels(choice.provider, cwd: cwd)
                loading = true
                models = await model.models(choice.provider, cwd: cwd)
                loading = false
                choice = choice.fitted(to: models)
            }
    }

    @ViewBuilder private var sections: some View {
        Section("Agent") {
            ForEach(Provider.allCases) { provider in
                OptionRow(selected: choice.provider == provider) {
                    guard choice.provider != provider else { return }
                    // Another agent: its own last-used settings, keeping the permission you picked.
                    let permission = choice.permissionMode
                    choice = model.defaultChoice(for: provider)
                    choice.permissionMode = permission
                } label: {
                    HStack(spacing: 10) {
                        AgentLogo(provider: provider, size: 18)
                        Text(provider == .claude ? "Claude Code" : "Codex")
                    }
                }
            }
        }

        Section {
            if loading && models.isEmpty {
                HStack { ProgressView(); Text("Loading models…").foregroundStyle(.secondary) }
            } else if models.isEmpty {
                Text("No models found on the computer for this agent.").foregroundStyle(.secondary)
            }
            ForEach(models) { option in
                OptionRow(selected: option.id == currentModel?.id, title: option.label, detail: option.description) {
                    // "default" (Claude) and the default-flagged model (Codex) are saved as empty.
                    choice.model = option.id == "default" ? "" : option.id
                    choice = choice.fitted(to: models)
                }
            }
        } header: {
            Text("Model")
        }

        if let current = currentModel, !current.efforts.isEmpty {
            Section {
                OptionRow(selected: choice.effort.isEmpty, title: "Default",
                          detail: current.defaultEffort.map { "The model’s own choice (\(AgentChoice.effortLabel($0)))." }
                            ?? "The model’s own choice.") {
                    choice.effort = ""
                }
                ForEach(current.efforts, id: \.self) { effort in
                    OptionRow(selected: choice.effort == effort, title: AgentChoice.effortLabel(effort),
                              detail: Self.effortDetail(effort)) {
                        choice.effort = effort
                    }
                }
            } header: {
                Text("Reasoning")
            }
        }

        if let tiers = currentModel?.serviceTiers, !tiers.isEmpty {
            Section("Speed") {
                OptionRow(selected: choice.serviceTier.isEmpty, title: "Standard", detail: "The usual speed and cost.") {
                    choice.serviceTier = ""
                }
                ForEach(tiers, id: \.id) { tier in
                    OptionRow(selected: choice.serviceTier == tier.id, title: tier.label,
                              detail: tier.description ?? "Faster replies; uses more of your plan.") {
                        choice.serviceTier = tier.id
                    }
                }
            }
        }

        Section("Permission") {
            ForEach(PermissionMode.all) { mode in
                OptionRow(selected: choice.permissionMode == mode.id, title: mode.label, detail: mode.description,
                          symbol: mode.symbol) {
                    choice.permissionMode = mode.id
                }
            }
        }
    }

    static func effortDetail(_ effort: String) -> String? {
        switch effort {
        case "none", "minimal": "Answers right away, with little or no thinking."
        case "low": "Quick; thinks briefly."
        case "medium": "Balanced speed and depth."
        case "high": "Thinks things through; slower."
        case "xhigh": "Thinks longer for hard problems."
        case "max", "ultra": "The most thinking; slowest and costliest."
        default: nil
        }
    }
}

/// One choice: a checkmark when selected, its title, and a description under it.
struct OptionRow<Label: View>: View {
    let selected: Bool
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    init(selected: Bool, action: @escaping () -> Void, @ViewBuilder label: @escaping () -> Label) {
        self.selected = selected
        self.action = action
        self.label = label
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                label()
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.tint)
                    .opacity(selected ? 1 : 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

extension OptionRow where Label == OptionText {
    init(selected: Bool, title: String, detail: String?, symbol: String? = nil, action: @escaping () -> Void) {
        self.init(selected: selected, action: action) {
            OptionText(title: title, detail: detail, symbol: symbol)
        }
    }
}

struct OptionText: View {
    let title: String
    let detail: String?
    let symbol: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if let symbol {
                Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 22)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).foregroundStyle(.primary)
                if let detail, !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// The open thread's agent settings, from the chip above the message box.
struct ThreadSettingsSheet: View {
    let thread: ChatThread
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var choice: AgentChoice
    @State private var saving = false
    @State private var problem: String?

    init(thread: ChatThread) {
        self.thread = thread
        _choice = State(initialValue: thread.info.settings)
    }

    private var running: Bool { thread.info.status.isRunning || thread.info.status == .waiting }

    var body: some View {
        NavigationStack {
            Form {
                if running {
                    Section {
                        Label("The agent is working. You can change these once it finishes or you stop it.",
                              systemImage: "hourglass")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if choice.provider != thread.info.provider {
                    Section {
                        Label("Switching to \(choice.provider.label): it continues this thread and gets a recap of what it missed.",
                              systemImage: "arrow.triangle.swap")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                AgentSettingsForm(choice: $choice, cwd: thread.info.cwd)
                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else {
                        Button("Save") { Task { await save() } }
                            .disabled(running || choice == thread.info.settings)
                    }
                }
            }
        }
    }

    private func save() async {
        saving = true
        problem = nil
        defer { saving = false }
        do {
            try await model.updateSettings(choice)
            dismiss()
        } catch {
            problem = error.localizedDescription
        }
    }
}

/// The chip above the message box: the agent's logo, model, reasoning, and permission. Tap to change.
struct AgentChip: View {
    let thread: ChatThread
    let action: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let settings = thread.info.settings
        let models = model.cachedModels(settings.provider, cwd: thread.info.cwd)
        let modelLabel = models.first { $0.id == settings.model }?.label
            ?? (settings.model.isEmpty ? (models.first { $0.isDefault == true }?.label ?? "Default model") : settings.model)
        Button(action: action) {
            HStack(spacing: 6) {
                AgentLogo(provider: settings.provider, size: 13)
                Text(modelLabel).lineLimit(1)
                if !settings.effort.isEmpty {
                    Text("· \(AgentChoice.effortLabel(settings.effort))").lineLimit(1)
                }
                if let mode = PermissionMode.named(settings.permissionMode) {
                    Text("·")
                    Image(systemName: mode.symbol)
                    Text(mode.label).lineLimit(1)
                }
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .floatingBackground(in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Agent settings")
        .task(id: "\(settings.provider.rawValue)|\(thread.info.cwd)") {
            _ = await model.models(settings.provider, cwd: thread.info.cwd)
        }
    }
}
