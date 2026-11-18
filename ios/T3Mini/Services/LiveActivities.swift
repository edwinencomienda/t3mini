@preconcurrency import ActivityKit
import UIKit
import Foundation

/// Starts and tracks Live Activities for threads (ios/LiveActivity/ThreadActivity.swift).
///
/// Sending a message starts one for that thread (or brings its existing one back to Working). Its
/// push token goes to the computer (POST /api/push/activity), which keeps it current through
/// Apple's push service while the app is closed. While the app is open, the thread list keeps it
/// right too (`sync`), so it still ends if the computer has no Apple push key.
@MainActor
final class LiveActivities {
    static let shared = LiveActivities()
    typealias Attributes = ThreadActivityAttributes

    /// Hands an activity's push token (hex) and thread to the computer. Set by AppModel.
    var register: ((_ token: String, _ thread: String) async -> Void)?
    private var observed: Set<String> = []

    var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    /// At launch: keep sending the tokens of activities that are still showing.
    func resume() {
        for activity in ActivityKit.Activity<Attributes>.activities { observe(activity) }
    }

    /// You sent a message in this thread: show it working.
    func start(threadId: String, title: String, project: String, provider: Provider, avatar: UIImage? = nil) {
        guard enabled else { return }
        let state = Attributes.ContentState(status: "working", steps: 0, startedAt: Date().timeIntervalSince1970)
        if let current = ActivityKit.Activity<Attributes>.activities.first(where: {
            $0.attributes.threadId == threadId && $0.activityState == .active
        }) {
            Task { await current.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        let attributes = Attributes(threadId: threadId, title: title.isEmpty ? "Thread" : title,
                                    project: project, provider: provider.rawValue,
                                    avatar: avatar.flatMap(Self.smallAvatar))
        do {
            let activity = try ActivityKit.Activity.request(attributes: attributes,
                                                content: ActivityContent(state: state, staleDate: nil),
                                                pushType: .token)
            observe(activity)
        } catch {
            // Turned off for the app, or too many showing: nothing to do.
        }
    }

    /// While the app is open: follow the thread list (status changes the computer may not have
    /// pushed, e.g. without an Apple push key).
    func sync(_ threads: [ThreadSummary]) {
        let now = Date().timeIntervalSince1970
        for activity in ActivityKit.Activity<Attributes>.activities where activity.activityState == .active {
            guard let thread = threads.first(where: { $0.id == activity.attributes.threadId }) else { continue }
            var state = activity.content.state
            let next: String
            switch thread.status {
            case .starting, .working: next = "working"
            case .waiting: next = "waiting"
            case .failed: next = "failed"
            case .interrupted: next = "stopped"
            default: next = "done"
            }
            guard next != state.status else { continue }
            let over = next == "done" || next == "failed" || next == "stopped"
            // Just sent: the computer may not have picked the message up yet.
            if over && now - state.startedAt < 20 { continue }
            state.status = next
            if over {
                state.endedAt = now
                Task {
                    await activity.end(ActivityContent(state: state, staleDate: nil),
                                       dismissalPolicy: .after(Date().addingTimeInterval(15 * 60)))
                }
            } else {
                Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
            }
        }
    }

    private func observe(_ activity: ActivityKit.Activity<Attributes>) {
        guard observed.insert(activity.id).inserted else { return }
        let thread = activity.attributes.threadId
        Task {
            for await data in activity.pushTokenUpdates {
                let token = data.map { String(format: "%02x", $0) }.joined()
                await register?(token, thread)
            }
        }
    }
}

extension LiveActivities {
    /// Apple keeps a Live Activity's data under 4 KB in all: the avatar goes in at the largest size
    /// that fits in about 2.5 KB, else none (its letter). PNG, not HEIC: the lock screen packages
    /// the activity's view, and a lazily decoded HEIC image left it as a grey placeholder.
    nonisolated static func smallAvatar(_ image: UIImage) -> Data? {
        for side in [72.0, 64, 56, 48, 40, 32] {
            let size = CGSize(width: side, height: side)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = false
            let drawn = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                let scale = min(side / max(image.size.width, 1), side / max(image.size.height, 1))
                let fitted = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                image.draw(in: CGRect(x: (side - fitted.width) / 2, y: (side - fitted.height) / 2,
                                      width: fitted.width, height: fitted.height))
            }
            if let data = drawn.pngData(), data.count <= 2500 { return data }
        }
        return nil
    }
}
