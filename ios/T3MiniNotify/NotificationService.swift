import UserNotifications

/// Runs on the phone when a push arrives (mutable-content), before it's shown: swaps the brief
/// line Apple could read ("A thread finished.") for the thread's title and project, which the
/// computer sealed with this phone's key (Shared/PushKey.swift). Anything off: the brief line stays.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.content = content
        if let sealed = content.userInfo["sealed"] as? String, let key = PushKey.load(),
           let opened = PushKey.open(sealed, with: key) {
            content.title = opened.title
            content.body = opened.body
        }
        content.userInfo["sealed"] = nil
        contentHandler(content)
    }

    // Out of time: show what arrived.
    override func serviceExtensionTimeWillExpire() {
        if let handler, let content { handler(content) }
    }
}
