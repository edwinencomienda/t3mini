import Foundation
import Testing
@testable import T3Mini

struct APIClientTests {
    func response(_ setCookie: String) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "https://mac.ts.net/pair")!, statusCode: 303, httpVersion: nil,
                        headerFields: ["Set-Cookie": setCookie])!
    }

    @Test func readsTheSessionCookie() {
        let https = APIClient.sessionCookie(from: response("__Host-t3m_session=abc_DEF-123; HttpOnly; Secure; SameSite=Lax; Path=/"))
        #expect(https?.name == "__Host-t3m_session")
        #expect(https?.value == "abc_DEF-123")
        let lan = APIClient.sessionCookie(from: response("t3m_session=xyz; HttpOnly; SameSite=Lax"))
        #expect(lan?.name == "t3m_session")
        #expect(lan?.value == "xyz")
        #expect(APIClient.sessionCookie(from: response("other=1")) == nil)
    }

    @Test func userAgentNamesTheApp() {
        #expect(APIClient.userAgent.hasPrefix("t3mini-ios/"))
        #expect(APIClient.userAgent.hasSuffix("(iPhone)") || APIClient.userAgent.hasSuffix("(iPad)"))
    }
}

struct NotificationTests {
    @Test func opensOnlyThreadLinks() {
        #expect(Notifications.threadId(from: "/threads/4cb511d1-ccb7") == "4cb511d1-ccb7")
        #expect(Notifications.threadId(from: "/threads/a%20b") == "a b")
        #expect(Notifications.threadId(from: "/threads/") == nil)
        #expect(Notifications.threadId(from: "/threads/a/b") == nil)
        #expect(Notifications.threadId(from: "https://evil.example/threads/a") == nil)
        #expect(Notifications.threadId(from: 42) == nil)
        #expect(Notifications.threadId(from: nil) == nil)
    }
}

import CryptoKit

struct PushKeyTests {
    // Sealed by the server's sealForApp (src/server/push.ts) with a throwaway key.
    @Test func opensWhatTheServerSealed() throws {
        let key = SymmetricKey(data: try #require(Data(base64Encoded: "KqD55E+kSDUBYgtTTQvVEo5dbzmOxQf5D4fKpObzTrA=")))
        let opened = try #require(PushKey.open("jfDvYeE/xNe6LzXtNNFbozuBjTGMsuIdaJPUFn7SD7SlJMMbqUZ0trldIz0+xELGxiMWiFIOrO/7L5UB4kIJ4L8ZIsWOaZdEgBKBFg==", with: key))
        #expect(opened.title == "Fix login")
        #expect(opened.body == "✅ Done · myapp")
        // The wrong key, or a changed message, opens nothing.
        #expect(PushKey.open("jfDvYeE/xNe6LzXtNNFbozuBjTGMsuIdaJPUFn7SD7SlJMMbqUZ0trldIz0+xELGxiMWiFIOrO/7L5UB4kIJ4L8ZIsWOaZdEgBKBFg==", with: SymmetricKey(size: .bits256)) == nil)
        #expect(PushKey.open("AAAAjfDvYeE/xNe6LzXtNNFbozuBjTGMsuIdaJPUFn7SD7SlJMMbqUZ0trldIz0+xELGxiMWiFIOrO/7L5UB4kIJ4L8ZIsWOaZdEgBKBFg==", with: key) == nil)
    }
}

@MainActor
struct NotificationOpenTests {
    @Test func aTapBeforeTheAppIsReadyStillOpensItsThread() {
        let notifications = Notifications.shared
        let saved = notifications.onOpenThread
        defer { notifications.onOpenThread = saved }
        notifications.onOpenThread = nil
        // Launched by the tap: nothing listening yet.
        notifications.open(thread: "t-1")
        var opened: [String] = []
        notifications.onOpenThread = { opened.append($0) }
        #expect(opened == ["t-1"])
        // Once ready, taps go straight through, and the kept one isn't replayed.
        notifications.open(thread: "t-2")
        notifications.onOpenThread = { opened.append($0) }
        #expect(opened == ["t-1", "t-2"])
    }
}
