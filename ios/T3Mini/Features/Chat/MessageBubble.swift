import SwiftUI

/// One message, like ChatGPT: yours in a bubble on the right, the agent's as plain text across
/// the whole width (no bubble), so long replies, code, and tables have room.
struct MessageBubble: View {
    let message: Message
    /// The time and copy button under it (in-between notes inside "Worked for…" don't show them).
    var showMeta = true

    private var mine: Bool { message.role == .user && message.report == nil }

    var body: some View {
        Group {
            if let report = message.report {
                ReportCard(report: report)
            } else if mine {
                HStack {
                    Spacer(minLength: 56)
                    VStack(alignment: .trailing, spacing: 6) {
                        ForEach(message.attachments ?? [], id: \.id) { attachment in
                            RemoteImage(id: attachment.id, maxHeight: 240)
                                .frame(maxWidth: 240)
                        }
                        if !message.text.isEmpty {
                            Text(message.text)
                                .lineSpacing(MarkdownText.lineSpacing)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .background(Color(.secondarySystemFill), in: .rect(cornerRadius: 22))
                        }
                        footer
                        if showMeta { MessageMeta(message: message, trailing: true) }
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    if !message.text.isEmpty {
                        MarkdownText(text: message.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(Array((message.blocks ?? []).enumerated()), id: \.offset) { _, block in
                        BlockView(block: block)
                    }
                    footer
                    if showMeta && !message.text.isEmpty { MessageMeta(message: message, trailing: false) }
                }
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder private var footer: some View {
        if message.queued == true || message.unsent == true {
            Text(message.unsent == true ? "Not sent" : "Queued")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

/// A helper thread's report back to its lead.
struct ReportCard: View {
    let report: HelperReport

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(report.title, systemImage: report.status == "failed" ? "xmark.octagon" : "checkmark.seal")
                .font(.subheadline.weight(.semibold))
            Text(report.answer)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(6)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 14))
    }
}

/// Under a message: copy its text, and when it was sent. Like ChatGPT and Claude.
struct MessageMeta: View {
    let message: Message
    let trailing: Bool
    @State private var copied = false

    var body: some View {
        HStack(spacing: 14) {
            if trailing { time }
            Button {
                UIPasteboard.general.string = message.text
                copied = true
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.footnote)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? "Copied" : "Copy message")
            if !trailing { time }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
    }

    private var time: some View {
        Text(MessageTime.label(message.createdAt)).font(.caption)
    }
}

/// One turn: your message, the agent's work (folded into "Worked for…" once it's done, live while
/// it runs), the pictures it showed, and its answer.
struct TurnView: View {
    let turn: Turn
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let user = turn.user { MessageBubble(message: user).id(user.id) }
            if let label = turn.foldLabel, turn.work.isEmpty {
                // Nothing to unfold: just how long it took.
                Text(label).font(.subheadline).foregroundStyle(.secondary)
            } else if let label = turn.foldLabel {
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        withAnimation(.snappy) { open.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Text(label)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .rotationEffect(.degrees(open ? 90 : 0))
                        }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if open { workList }
                    Divider()
                }
            } else if !turn.done {
                workList
            }
            ForEach(Array(turn.blocks.enumerated()), id: \.offset) { _, block in BlockView(block: block) }
            if let answer = turn.answer { MessageBubble(message: answer).id(answer.id) }
        }
    }

    /// The agent's in-between notes and steps, in order.
    private var workList: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(turn.work) { item in
                switch item {
                case .note(let message):
                    MessageBubble(message: message, showMeta: false)
                        .opacity(turn.done ? 0.85 : 1)
                        .id(message.id)
                case .step(let activity):
                    StepRow(activity: activity)
                }
            }
        }
    }
}

/// A tool step: what the agent did, with its outcome.
struct StepRow: View {
    let activity: Activity

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                switch activity.status {
                case "running": ProgressView().controlSize(.mini)
                case "failed": Image(systemName: "xmark.circle").foregroundStyle(.red)
                default: Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            .frame(width: 16)
            Text(activity.line)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
        }
    }
}
