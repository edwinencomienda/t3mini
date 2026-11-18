import SwiftUI

/// Something the agent is waiting on: Allow / Deny, or its multiple-choice questions.
struct ApprovalCard: View {
    let approval: Approval
    @Environment(AppModel.self) private var model
    @State private var picks: [String: Set<String>] = [:]
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(approval.title, systemImage: approval.questions == nil ? "hand.raised" : "questionmark.bubble")
                .font(.subheadline.weight(.semibold))
            if let questions = approval.questions, !questions.isEmpty {
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
