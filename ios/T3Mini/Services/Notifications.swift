import Foundation
import UIKit
import UserNotifications

/// Push notifications for this app (server: src/server/push.ts and apns.ts). The phone asks
/// Apple for a device token, sends it to the paired computer, and the computer sends a short
/// note through Apple when a thread finishes, fails, or needs you. Apple can read those notes,
/// so they never include the thread's title or project; tapping one opens the thread here.
@MainActor
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifications()

    /// Set by the app: gets the device token to register, and a thread to open.
    var onToken: ((String) -> Void)?
    /// A tap can arrive before the app has set this (launched by the tap itself): the thread is
    /// kept and handed over as soon as it's set, so the tap is never lost.
    var onOpenThread: ((String) -> Void)? {
        didSet {
            if let handler = onOpenThread, let id = pendingThread {
                pendingThread = nil
                handler(id)
            }
        }
    }
    private var pendingThread: String?

    func open(thread id: String) {
        if let onOpenThread { onOpenThread(id) } else { pendingThread = id }
    }
    var visibleThread: () -> String? = { nil }
    private(set) var token: String?

    /// Builds from Xcode or run-on-device.sh use Apple's sandbox; TestFlight and the App Store
    /// use production.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    func start() {
        UNUserNotificationCenter.current().delegate = self
    }

    var authorization: UNAuthorizationStatus {
        get async { await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }
    }

    /// Asks once (iOS remembers the answer), then registers with Apple.
    func enable() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    /// At launch: already allowed, so register again (Apple can change the token).
    func refresh() async {
        if await authorization == .authorized { UIApplication.shared.registerForRemoteNotifications() }
    }

    func received(token data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        token = hex
        onToken?(hex)
    }

    /// "/threads/<id>" from a notification → the thread id (anything else is ignored).
    nonisolated static func threadId(from url: Any?) -> String? {
        guard let url = url as? String, url.hasPrefix("/threads/") else { return nil }
        let id = String(url.dropFirst("/threads/".count))
        guard !id.isEmpty, !id.contains("/"), let decoded = id.removingPercentEncoding, !decoded.isEmpty else { return nil }
        return decoded
    }

    // iOS requires these completion handlers to be called on the main thread. The async versions
    // of these methods can finish on a background thread under Swift 6, which made iOS stop the
    // app when a notification was tapped (UIApplication's snapshot assertion). So: plain
    // completion handlers, always called on the main queue.

    // A notification while the app is open: shown, unless it's about the thread on screen.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let id = Self.threadId(from: notification.request.content.userInfo["url"])
        // Called exactly once, on the main queue, as iOS requires.
        nonisolated(unsafe) let done = completionHandler
        DispatchQueue.main.async {
            let visible = MainActor.assumeIsolated { self.visibleThread() }
            done(id != nil && id == visible ? [] : [.banner, .sound, .list])
        }
    }

    // Tapped: open its thread (now, or once the app is ready).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = Self.threadId(from: response.notification.request.content.userInfo["url"])
        // Called exactly once, on the main queue, as iOS requires.
        nonisolated(unsafe) let done = completionHandler
        DispatchQueue.main.async {
            if let id { MainActor.assumeIsolated { self.open(thread: id) } }
            done()
        }
    }
}

/// The UIKit hooks push needs (SwiftUI has no other way to get the device token).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { Notifications.shared.start() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { Notifications.shared.received(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("Push registration failed: \(error.localizedDescription)")
    }
}
