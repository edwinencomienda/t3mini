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
                    ActivityAvatar(attributes: context.attributes, state: state, size: 40)
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
                ActivityAvatar(attributes: context.attributes, state: state, size: 22, badge: false)
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
            ActivityAvatar(attributes: attributes, state: state, size: 44)
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

/// The project's avatar, as in the app (its picture, or its letter on a soft tint of its color),
/// with the status (working, done…) in a small badge on its corner, like a contact's photo.
private struct ActivityAvatar: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState
    let size: CGFloat
    var badge = true
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
        Group {
            if let image = Self.bitmap(attributes.avatar) {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                let hue = AvatarColor.hue(attributes.project)
                let dark = scheme == .dark
                ZStack {
                    shape.fill(AvatarColor.oklch(0.62, 0.12, hue).opacity(dark ? 0.32 : 0.16))
                    Text(AvatarColor.initial(attributes.project))
                        .font(.system(size: size * 0.45, weight: .bold))
                        .foregroundStyle(dark ? AvatarColor.oklch(0.82, 0.11, hue) : AvatarColor.oklch(0.5, 0.14, hue))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(alignment: .bottomTrailing) {
            if badge {
                Image(systemName: state.symbol)
                    .font(.system(size: size * 0.3, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: size * 0.44, height: size * 0.44)
                    .background(statusColor(state) == .secondary ? Color.gray : statusColor(state), in: Circle())
                    .overlay(Circle().stroke(.black.opacity(0.25), lineWidth: 1))
                    .offset(x: size * 0.12, y: size * 0.12)
            }
        }
        .accessibilityHidden(true)
    }

    /// The picture drawn into a plain bitmap here, so it packages cleanly for the lock screen.
    static func bitmap(_ data: Data?) -> UIImage? {
        guard let data, let decoded = UIImage(data: data), decoded.size.width > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        return UIGraphicsImageRenderer(size: decoded.size, format: format).image { _ in
            decoded.draw(in: CGRect(origin: .zero, size: decoded.size))
        }
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
