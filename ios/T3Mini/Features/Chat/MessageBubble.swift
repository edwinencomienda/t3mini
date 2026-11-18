import SwiftUI

/// One message, like ChatGPT: yours in a bubble on the right, the agent's as plain text across
/// the whole width (no bubble), so long replies, code, and tables have room.
struct MessageBubble: View {
    let message: Message

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
