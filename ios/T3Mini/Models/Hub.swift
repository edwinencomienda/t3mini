import Foundation

/// Other machines (docs/machines.md): a computer paired to the one this phone is paired with,
/// whose threads show in the same list. Their threads keep living on that machine; the phone
/// reaches them through its own computer at /api/m/<machine>/… (the computer adds the machine's
/// session, which never comes to the phone).
///
/// Like the web app (src/hub.ts), a machine's thread ids and project folders carry the machine:
/// "m~<machine>~<thread id>", so they never mix with the computer's own (the same folder can
/// exist on both) and every call for them goes to the right place.
struct HubMachine: Codable, Hashable, Sendable, Identifiable {
    let id: String
    var name: String
}

enum Hub {
    static let mark = "m~"

    static func id(_ machine: String, _ value: String) -> String { "\(mark)\(machine)~\(value)" }

    /// The machine and the machine's own id (or folder) for a hub id; nil for the computer's own.
    static func parse(_ value: String?) -> (machine: String, id: String)? {
        guard let value, value.hasPrefix(mark) else { return nil }
        let rest = value.dropFirst(mark.count)
        guard let split = rest.firstIndex(of: "~"), split > rest.startIndex else { return nil }
        return (String(rest[..<split]), String(rest[rest.index(after: split)...]))
    }

    static func machine(of value: String?) -> String? { parse(value)?.machine }

    /// The id or folder on its machine (what to show, copy, or send there).
    static func local(_ value: String) -> String { parse(value)?.id ?? value }
}

extension ProjectSummary {
    /// Its name, with its machine's for a machine's project ("app · vps").
    var listName: String { machine.map { "\(displayName) · \($0)" } ?? displayName }
}

extension ThreadSummary {
    func onMachine(_ machine: HubMachine) -> ThreadSummary {
        var item = self
        item.id = Hub.id(machine.id, id)
        item.cwd = Hub.id(machine.id, cwd)
        item.parentId = parentId.map { Hub.id(machine.id, $0) }
        item.machine = machine.name
        return item
    }
}

extension ProjectSummary {
    func onMachine(_ machine: HubMachine) -> ProjectSummary {
        var item = self
        item.path = Hub.id(machine.id, path)
        item.machine = machine.name
        return item
    }
}

extension ThreadInfo {
    func onMachine(_ machine: String) -> ThreadInfo {
        var info = self
        info.id = Hub.id(machine, id)
        info.cwd = Hub.id(machine, cwd)
        return info
    }
}

extension ChatThread {
    func onMachine(_ machine: String) -> ChatThread {
        var thread = self
        thread.info = info.onMachine(machine)
        return thread
    }
}

extension ThreadPatch {
    func onMachine(_ machine: String) -> ThreadPatch {
        var patch = self
        patch.id = Hub.id(machine, id)
        patch.rest = rest?.onMachine(machine)
        return patch
    }
}
