import SwiftUI

/// Something the agent is waiting on: Allow / Deny, or its multiple-choice questions.
struct ApprovalCard: View {
    let approval: Approval
    @Environment(AppModel.self) private var model
    @State private var picks: [String: Set<String>] = [:]
    @State private var working = false
    @State private var problem: String?
    /// A secret card's value: only in this field until it's sent, then cleared.
    @State private var secretValue = ""
    @State private var secretShown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(approval.secret.map { "The agent needs \($0.name)" } ?? approval.title,
                  systemImage: approval.secret != nil ? "key.fill" : approval.questions == nil ? "hand.raised" : "questionmark.bubble")
                .font(.subheadline.weight(.semibold))
            if let secret = approval.secret {
                secretFields(secret)
            } else if let questions = approval.questions, !questions.isEmpty {
                ForEach(questions, id: \.question) { question in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(question.question).font(.callout)
                        ForEach(question.options, id: \.label) { option in
                            optionButton(question, option)
                        }
                    }
                }
                Button("Send answers") { Task { await answer() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(working || questions.contains { (picks[$0.question] ?? []).isEmpty })
            } else {
                if !approval.detail.isEmpty {
                    Text(approval.detail)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(8)
                }
                HStack {
                    Button("Allow") { Task { await decide(true) } }.buttonStyle(.borderedProminent)
                    Button("Deny", role: .destructive) { Task { await decide(false) } }.buttonStyle(.bordered)
                }
                .disabled(working)
            }
            if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.orange.opacity(0.4)))
    }

    private func optionButton(_ question: Question, _ option: QuestionOption) -> some View {
        let chosen = picks[question.question]?.contains(option.label) == true
        return Button {
            var set = picks[question.question] ?? []
            if question.multiSelect == true {
                if chosen { set.remove(option.label) } else { set.insert(option.label) }
            } else {
                set = [option.label]
            }
            picks[question.question] = set
        } label: {
            HStack(alignment: .top) {
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).foregroundStyle(.primary)
                    if let description = option.description {
                        Text(description).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    /// request_secret: a password field. The value goes straight to the env file on the computer;
    /// the agent never sees it, and it isn't kept in the chat or on the phone.
    @ViewBuilder private func secretFields(_ secret: SecretRequest) -> some View {
        Text(secret.reason).font(.callout).foregroundStyle(.secondary)
        HStack(spacing: 6) {
            Group {
                if secretShown {
                    TextField("Paste it here", text: $secretValue)
                } else {
                    SecureField("Paste it here", text: $secretValue)
                }
            }
            .font(.system(.callout, design: .monospaced))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.password)
            .privacySensitive()
            Button { secretShown.toggle() } label: {
                Image(systemName: secretShown ? "eye.slash" : "eye")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel(secretShown ? "Hide" : "Show")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(.systemBackground), in: .rect(cornerRadius: 10))
        Text("Saved to \(secret.file) on your computer. The agent never sees it, and it isn't kept in this chat.")
            .font(.caption)
            .foregroundStyle(.secondary)
        HStack {
            Button("Save") {
                let value = secretValue
                Task {
                    await act { try await model.provideSecret(approval, value: value) }
                    if problem == nil { secretValue = "" }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(secretValue.isEmpty)
            Button("Skip") { Task { await decide(false) } }.buttonStyle(.bordered)
        }
        .disabled(working)
    }

    private func decide(_ allow: Bool) async {
        await act { try await model.answer(approval, allow: allow) }
    }

    private func answer() async {
        // The same shape the web app sends: question → chosen labels, comma-separated.
        let answers = Dictionary(uniqueKeysWithValues: (approval.questions ?? []).map { question in
            (question.question, (question.options.map(\.label).filter { picks[question.question]?.contains($0) == true })
                .joined(separator: ", "))
        })
        await act { try await model.answer(approval, allow: true, answers: answers) }
    }

    private func act(_ action: () async throws -> Void) async {
        working = true
        problem = nil
        defer { working = false }
        do { try await action() } catch { problem = error.localizedDescription }
    }
}
