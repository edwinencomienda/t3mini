import ActivityKit
import SwiftUI
import WidgetKit

@main
struct T3MiniWidgets: WidgetBundle {
    var body: some Widget {
        ThreadActivityWidget()
    }
}

/// A thread at work, on the lock screen and in the Dynamic Island: its title and project, what
/// it's doing (Working, Waiting for you, Done…), its steps, and a running timer. Tap to open it.
struct ThreadActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ThreadActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .widgetURL(ThreadLink.url(for: context.attributes.threadId))
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: state.symbol)
                        .font(.title2)
                        .foregroundStyle(statusColor(state))
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Elapsed(state: state).font(.title3.monospacedDigit()).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title).font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("\(context.attributes.project) · \(state.detail)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } compactLeading: {
                Image(systemName: state.symbol).foregroundStyle(statusColor(state))
            } compactTrailing: {
                Elapsed(state: state)
                    .font(.caption2.monospacedDigit())
                    .frame(maxWidth: 44)
            } minimal: {
                Image(systemName: state.symbol).foregroundStyle(statusColor(state))
            }
            .widgetURL(ThreadLink.url(for: context.attributes.threadId))
        }
    }
}

private struct LockScreenView: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: state.symbol)
                .font(.title2)
                .foregroundStyle(statusColor(state))
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(attributes.project)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(attributes.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(state.detail)
                    .font(.subheadline)
                    .foregroundStyle(state.status == "waiting" ? statusColor(state) : .secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if !state.isOver {
                Elapsed(state: state)
                    .font(.title3.monospacedDigit().weight(.medium))
                    .frame(maxWidth: 76, alignment: .trailing)
            }
        }
        .padding(16)
    }
}

/// The time since your message, counting on its own (no updates needed); once it's over, the
/// total.
private struct Elapsed: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        if let ended = state.ended, state.isOver {
            Text(ThreadActivityAttributes.ContentState.duration(ended.timeIntervalSince(state.started)))
        } else {
            Text(timerInterval: state.started...Date.distantFuture, countsDown: false)
                .multilineTextAlignment(.trailing)
        }
    }
}

private func statusColor(_ state: ThreadActivityAttributes.ContentState) -> Color {
    switch state.status {
    case "waiting": .orange
    case "done": .green
    case "failed": .red
    case "stopped": .secondary
    default: .accentColor
    }
}
