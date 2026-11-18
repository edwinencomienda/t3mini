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
