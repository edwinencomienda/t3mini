import Testing
@testable import T3Mini

struct PairingLinkTests {
    let code = "abcDEF123_-abcDEF123_-xy"

    @Test func tailscaleLink() throws {
        let link = try PairingLink("  https://mac.tailnet.ts.net:8443/pair?code=\(code)\n")
        #expect(link.server.absoluteString == "https://mac.tailnet.ts.net:8443")
        #expect(link.code == code)
    }

    @Test func localNetworkLinkOnlyForPrivateAddresses() throws {
        #expect(try PairingLink("http://192.168.1.20:4311/pair?code=\(code)").server.absoluteString == "http://192.168.1.20:4311")
        #expect(try PairingLink("http://10.0.0.5:4311/pair?code=\(code)").code == code)
        #expect(try PairingLink("http://172.20.1.1:4311/pair?code=\(code)").code == code)
        #expect(throws: PairingLink.Problem.insecure) { try PairingLink("http://example.com/pair?code=\(code)") }
        #expect(throws: PairingLink.Problem.insecure) { try PairingLink("http://172.32.0.1/pair?code=\(code)") }
        #expect(throws: PairingLink.Problem.insecure) { try PairingLink("http://8.8.8.8/pair?code=\(code)") }
    }

    @Test func rejectsOtherLinks() {
        #expect(throws: PairingLink.Problem.notALink) { try PairingLink("hello") }
        #expect(throws: PairingLink.Problem.notALink) { try PairingLink("ftp://mac/pair?code=\(code)") }
        #expect(throws: PairingLink.Problem.notAPairingLink) { try PairingLink("https://mac.ts.net/other?code=\(code)") }
        #expect(throws: PairingLink.Problem.notAPairingLink) { try PairingLink("https://mac.ts.net/pair?code=short") }
        #expect(throws: PairingLink.Problem.notAPairingLink) { try PairingLink("https://mac.ts.net/pair?code=\(code)%3Cscript") }
    }

    @Test func dropsEverythingButTheAddress() throws {
        let link = try PairingLink("https://user:pw@mac.ts.net/pair?code=\(code)#x")
        #expect(link.server.absoluteString == "https://mac.ts.net")
    }
}
