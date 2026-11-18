import SwiftUI

/// Tap the title pill: everything about the thread at a glance, like the web sidebar's hover card.
/// The full title, its status and times, the agent and how it runs (with a way to change it),
/// the project, folder, branch, and open pull request, and how long the conversation is.
struct ThreadDetailsSheet: View {
    let thread: ChatThread
    let branch: String?
    let editSettings: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var pullRequest: PullRequest?
    @State private var copiedPath = false

    private var info: ThreadInfo { thread.info }
    private var summary: ThreadSummary? { model.threads.first { $0.id == thread.id } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            ProjectAvatar(name: model.projectName(for: info.cwd), project: model.project(at: info.cwd), size: 36)
                            Text(info.title)
                                .font(.headline)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text(statusLine)
                            .font(.subheadline)
                            .foregroundStyle(statusColor)
                    }
                    .padding(.vertical, 4)
                    if let started = thread.messages.first?.createdAt {
                        LabeledContent("Started", value: MessageTime.label(started))
                    }
                    if let updated = summary?.lastMessageAt ?? summary?.updatedAt {
                        LabeledContent("Last activity", value: MessageTime.label(updated))
                    }
                    LabeledContent("Messages", value: "\(thread.messages.count)")
                    if !thread.activities.isEmpty {
                        LabeledContent("Steps in the latest run", value: "\(thread.activities.count)")
                    }
                }

                Section("Agent") {
                    LabeledContent {
                        Text(info.provider == .claude ? "Claude Code" : "Codex")
                    } label: {
                        HStack(spacing: 8) { AgentLogo(provider: info.provider, size: 16); Text("Agent") }
                    }
                    LabeledContent("Model", value: modelLabel)
                    LabeledContent("Reasoning", value: AgentChoice.effortLabel(info.effort ?? ""))
                    if let tier = info.serviceTier, !tier.isEmpty {
                        LabeledContent("Speed", value: tier.prefix(1).uppercased() + tier.dropFirst())
                    }
                    LabeledContent("Permission", value: PermissionMode.named(info.settings.permissionMode)?.label ?? info.settings.permissionMode)
                    Button {
                        dismiss()
                        editSettings()
                    } label: {
                        Label("Change agent settings", systemImage: "slider.horizontal.3")
                    }
                }

                Section("Project") {
                    LabeledContent("Project", value: model.projectName(for: info.cwd))
                    Button {
                        UIPasteboard.general.string = info.cwd
                        copiedPath = true
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    } label: {
                        LabeledContent {
                            Image(systemName: copiedPath ? "checkmark" : "doc.on.doc").foregroundStyle(.secondary)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Folder").foregroundStyle(.primary)
                                Text(info.cwd)
                                    .font(.footnote.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                    .truncationMode(.middle)
                            }
                        }
                    }
                    .accessibilityLabel(copiedPath ? "Folder path copied" : "Copy folder path")
                    if let branch {
                        LabeledContent("Branch") {
                            Label(branch, systemImage: "arrow.triangle.branch").labelStyle(.titleAndIcon)
                        }
                    }
                    if info.worktree != nil {
                        LabeledContent("Worktree", value: "Its own copy of the project")
                    }
                    if let pullRequest, let url = URL(string: pullRequest.url), url.scheme == "https" {
                        Button { openURL(url) } label: {
                            LabeledContent("Pull request") {
                                Label("#\(pullRequest.number)", systemImage: "arrow.up.right.square")
                                    .labelStyle(.titleAndIcon)
                            }
                        }
                    }
                }

                if let helpers = model.helpersByLead[thread.id], !helpers.isEmpty {
                    Section("Helper threads") {
                        ForEach(helpers) { helper in
                            Button {
                                dismiss()
                                model.pushThread = helper.id
                            } label: {
                                HStack(spacing: 10) {
                                    AgentLogo(provider: helper.provider, size: 15)
                                    Text(helper.title).foregroundStyle(.primary).lineLimit(2)
                                    Spacer(minLength: 6)
                                    ThreadStatusLabel(thread: helper, now: Date())
                                }
                            }
                        }
                    }
                }

                if let error = info.error, info.status == .failed {
                    Section("Error") {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { pullRequest = await model.pullRequest(of: thread.id) }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var modelLabel: String {
        let models = model.cachedModels(info.provider, cwd: info.cwd)
        let id = info.model ?? ""
        if let match = models.first(where: { $0.id == id }) { return match.label }
        if id.isEmpty { return models.first { $0.isDefault == true }?.label ?? "Default" }
        return id
    }

    private var statusLine: String {
        switch info.status {
        case .starting, .working: "Working"
        case .waiting: "Waiting for you"
        case .failed: "Failed"
        case .interrupted: "Stopped"
        case .completed: info.completedAt.map { "Done · \(MessageTime.label($0))" } ?? "Done"
        default: "Idle"
        }
    }

    private var statusColor: Color {
        switch info.status {
        case .starting, .working: .accentColor
        case .waiting: .orange
        case .failed: .red
        default: .secondary
        }
    }
}
