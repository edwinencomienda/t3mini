import Foundation

/// A pairing link from t3 mini (Settings → Devices → Connect a device, or `t3mini pair`):
/// `https://mac.tailnet.ts.net:8443/pair?code=…` (Tailscale) or `http://10.0.0.5:4311/pair?code=…`
/// (local network). Same rules as the server's machines.ts: HTTPS for any host, plain HTTP only
/// for private network addresses, so a session never travels unencrypted over the internet.
struct PairingLink: Equatable, Sendable {
    /// The gateway's address, e.g. https://mac.tailnet.ts.net:8443
    let server: URL
    let code: String

    enum Problem: LocalizedError, Equatable {
        case notALink, notAPairingLink, insecure
        var errorDescription: String? {
            switch self {
            case .notALink:
                return "That isn’t a link. Scan the QR code, or paste the whole link from t3 mini."
            case .notAPairingLink:
                return "That isn’t a t3 mini pairing link (it should end in /pair?code=…)."
            case .insecure:
                return "Plain http:// links only work for addresses on your local network. Use the Tailscale (HTTPS) link."
            }
        }
    }

    init(_ text: String) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              scheme == "https" || scheme == "http"
        else { throw Problem.notALink }
        let code = components.queryItems?.first(where: { $0.name == "code" })?.value ?? ""
        // Codes are 24 base64url characters (the server accepts 16–64).
        guard components.path == "/pair",
              (16...64).contains(code.count),
              code.allSatisfy({ $0.isLetter && $0.isASCII || $0.isNumber && $0.isASCII || $0 == "-" || $0 == "_" })
        else { throw Problem.notAPairingLink }
        if scheme == "http", !Self.isPrivateIPv4(host) { throw Problem.insecure }
        // No user info, path, query, or fragment in the saved address: just scheme, host, port.
        var base = URLComponents()
        base.scheme = scheme
        base.host = host
        base.port = components.port
        guard let server = base.url else { throw Problem.notALink }
        self.server = server
        self.code = code
    }

    /// 10/8, 172.16/12, 192.168/16, 169.254/16: the ranges the gateway serves on.
    static func isPrivateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
        guard parts.count == 4, host.split(separator: ".").count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (10, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        default: return false
        }
    }
}
