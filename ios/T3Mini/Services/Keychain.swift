import Foundation
import Security

/// The paired computer: its gateway address and the session cookie it gave this phone.
/// The cookie is a 30-day credential that can run agents on that computer, so it lives only in
/// the Keychain, readable after the first unlock, and never syncs or moves to another device.
struct Connection: Codable, Equatable, Sendable {
    var server: URL
    /// The cookie's name and value, e.g. "__Host-t3m_session" and the token.
    var cookieName: String
    var cookieValue: String
    var pairedAt: Date

    var cookieHeader: String { "\(cookieName)=\(cookieValue)" }
    var displayHost: String { server.host() ?? server.absoluteString }
}

enum Keychain {
    private static let service = "t3mini.connection"
    private static let account = "default"

    static func load() -> Connection? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return try? JSONDecoder().decode(Connection.self, from: data)
    }

    @discardableResult
    static func save(_ connection: Connection) -> Bool {
        guard let data = try? JSONEncoder().encode(connection) else { return false }
        delete()
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
