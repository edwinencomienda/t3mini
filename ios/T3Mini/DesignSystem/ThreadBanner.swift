import SwiftUI

/// A thread you aren't in finished, failed, or needs you while the app is open: a banner drops in
/// at the top, like a new message in iMessage. Tap it to go to that thread; swipe it up to put it
/// away. It comes from the live updates, so it shows at once and without Apple's push service.
struct ThreadBanner: Equatable, Identifiable {
    enum Event: Equatable {
        case done, failed, question, approval

        /// What a status change means, or nil when it isn't worth a banner (stopped, started…).
        init?(was: ThreadStatus, now: ThreadStatus, waitingFor: String?) {
            guard was != now else { return nil }
            let wasActive = was.isRunning || was == .waiting
            switch now {
            case .completed where wasActive: self = .done
            case .failed where wasActive: self = .failed
            case .waiting where was.isRunning: self = waitingFor == "question" ? .question : .approval
            default: return nil
            }
        }

        var label: String {
            switch self {
            case .done: "Done"
            case .failed: "Failed"
            case .question: "Has a question"
            case .approval: "Needs your approval"
            }
        }

        var symbol: String {
            switch self {
            case .done: "checkmark.circle.fill"
            case .failed: "exclamationmark.triangle.fill"
            case .question: "questionmark.bubble.fill"
            case .approval: "hand.raised.fill"
            }
        }

        var color: Color {
            switch self {
            case .done: .green
            case .failed: .red
            case .question, .approval: .orange
            }
        }
    }

    let id = UUID()
    let threadId: String
    let title: String
    let project: String
    let cwd: String
    let event: Event
}

struct ThreadBannerView: View {
    @Environment(AppModel.self) private var model
    let banner: ThreadBanner
    @State private var drag: CGFloat = 0

    private static let card = Color(UIColor {
        $0.userInterfaceStyle == .dark ? UIColor(white: 0.17, alpha: 1) : .systemBackground
    })

    var body: some View {
        let project = model.projectsByPath[banner.cwd]
        HStack(spacing: 12) {
            ProjectAvatar(name: banner.project, project: project, size: 36, square: true,
                          cached: project.flatMap { model.cachedAvatar($0) })
            VStack(alignment: .leading, spacing: 2) {
                Text(banner.title.isEmpty ? "Thread" : banner.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Image(systemName: banner.event.symbol).foregroundStyle(banner.event.color)
                    Text("\(banner.event.label) · \(banner.project)")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .font(.footnote)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(.rect)
        // Solid, like iOS's own banners (glass let the buttons behind it show through).
        .background {
            let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
            shape.fill(Self.card)
                .overlay(shape.stroke(Color(.separator).opacity(0.35), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.14), radius: 18, y: 6)
        }
        .padding(.horizontal, 12)
        .offset(y: min(0, drag))
        .onTapGesture { withAnimation(.snappy) { model.openBanner() } }
        .gesture(
            DragGesture(minimumDistance: 6)
                .onChanged { drag = $0.translation.height }
                .onEnded { value in
                    if value.translation.height < -24 || value.predictedEndTranslation.height < -60 {
                        withAnimation(.snappy) { model.dismissBanner() }
                    } else {
                        withAnimation(.snappy) { drag = 0 }
                    }
                }
        )
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens the thread")
    }
}
