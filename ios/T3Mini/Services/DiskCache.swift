import CryptoKit
import Foundation

/// Files kept on this phone so pictures and project icons survive the app being closed or iOS
/// freeing memory: they show at once instead of loading again. In Caches (never backed up; iOS
/// may clear it when space runs low), one folder per paired computer, under hashed names, with
/// file protection until the phone is first unlocked. Bounded: the oldest go past `limit`.
final class DiskCache: Sendable {
    let folder: URL
    let limit: Int

    init(scope: String, limit: Int = 300 * 1024 * 1024) {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        folder = base.appending(path: "t3mini/" + Self.hash(scope), directoryHint: .isDirectory)
        self.limit = limit
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    static func hash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func file(_ key: String) -> URL { folder.appending(path: Self.hash(key)) }

    func read(_ key: String) -> Data? { try? Data(contentsOf: file(key)) }

    func write(_ key: String, _ data: Data) {
        try? data.write(to: file(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Keeps the folder under its limit, oldest first.
    func trim() {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)
        else { return }
        let entries = files.compactMap { url -> (URL, Date, Int)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0)
        }
        var total = entries.reduce(0) { $0 + $1.2 }
        for (url, _, size) in entries.sorted(by: { $0.1 < $1.1 }) where total > limit {
            try? FileManager.default.removeItem(at: url)
            total -= size
        }
    }

    func removeAll() { try? FileManager.default.removeItem(at: folder) }
}
