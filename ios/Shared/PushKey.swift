import CryptoKit
import Foundation
import Security

/// The key push notifications are sealed with (src/server/push.ts → sealForApp): made on this
/// phone, given to the paired computer when notifications are turned on, and kept in a Keychain
/// group shared with the notification extension, which opens the title and project with it.
/// It's the only thing the extension can read: the computer's session stays in the app's own
/// Keychain.
enum PushKey {
    private static let service = "t3mini.pushkey"

    private static var group: String? {
        Bundle.main.object(forInfoDictionaryKey: "T3MiniSharedKeychain") as? String
    }

    private static func query() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "default",
        ]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    static func load() -> SymmetricKey? {
        var query = query()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, data.count == 32
        else { return nil }
        return SymmetricKey(data: data)
    }

    /// The key, made the first time (256 random bits).
    static func loadOrCreate() -> SymmetricKey? {
        if let key = load() { return key }
        let key = SymmetricKey(size: .bits256)
        var item = query()
        item[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        // The extension runs while the phone is locked, so: after first unlock, this device only.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? key : nil
    }

    static func base64(_ key: SymmetricKey) -> String {
        key.withUnsafeBytes { Data($0) }.base64EncodedString()
    }

    /// Opens a sealed {title, body} (AES-GCM, nonce · ciphertext · tag), or nil.
    static func open(_ sealed: String, with key: SymmetricKey) -> (title: String, body: String)? {
        guard let data = Data(base64Encoded: sealed),
              let box = try? AES.GCM.SealedBox(combined: data),
              let plain = try? AES.GCM.open(box, using: key),
              let content = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let title = content["title"] as? String, let body = content["body"] as? String
        else { return nil }
        return (String(title.prefix(200)), String(body.prefix(300)))
    }
}
