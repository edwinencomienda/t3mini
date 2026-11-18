import Foundation
import Testing
@testable import T3Mini

struct ThreadListTests {
    let now = ISO8601DateFormatter().date(from: "2026-11-18T12:00:00Z")!
    var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    func thread(_ id: String, cwd: String = "/p/app", at: String = "2026-11-18T11:00:00Z",
                status: ThreadStatus = .idle, unread: Bool? = nil, waitingFor: String? = nil) -> ThreadSummary {
        ThreadSummary(id: id, title: id, provider: .claude, cwd: cwd, status: status, updatedAt: at,
                      lastMessageAt: at, waitingFor: waitingFor, parentId: nil, chat: nil, unread: unread)
    }

    @Test func statusWordsMatchTheWebSidebar() {
        #expect(ThreadStatusLabel.label(thread("a", status: .waiting, waitingFor: "question"), now: now) == "Question")
        #expect(ThreadStatusLabel.label(thread("a", status: .waiting), now: now) == "Approval")
        #expect(ThreadStatusLabel.label(thread("a", status: .completed, unread: true), now: now) == "Done")
        #expect(ThreadStatusLabel.label(thread("a", status: .failed, unread: true), now: now) == "Failed")
        #expect(ThreadStatusLabel.label(thread("a", at: "2026-11-18T11:59:30Z", status: .completed), now: now) == "now")
        #expect(ThreadStatusLabel.label(thread("a", at: "2026-11-18T11:55:00Z"), now: now) == "5m")
        #expect(ThreadStatusLabel.label(thread("a", at: "2026-11-18T09:00:00Z"), now: now) == "3h")
        #expect(ThreadStatusLabel.label(thread("a", at: "2026-11-16T09:00:00Z"), now: now) == "2d")
    }

    @Test func groupsByProjectInTheOrderTheyWereAdded() {
        let projects = [
            ProjectSummary(path: "/p/web", name: nil, chats: nil, lastActiveAt: nil, addedAt: "2026-02-01"),
            ProjectSummary(path: "/p/api", name: "API", chats: nil, lastActiveAt: nil, addedAt: "2026-01-01"),
        ]
        let sections = ThreadSection.group(
            [thread("1", cwd: "/p/web"), thread("2", cwd: "/p/api"), thread("3", cwd: "/p/web")],
            by: "project", projects: projects, now: now, calendar: utc)
        #expect(sections.map(\.id) == ["p:/p/api", "p:/p/web"])
        #expect(sections[1].threads.map(\.id) == ["1", "3"])
        let plainRows = sections.allSatisfy { !$0.showProject }
        #expect(plainRows)
    }

    @Test func groupsByDate() {
        let sections = ThreadSection.group(
            [thread("today"), thread("yesterday", at: "2026-11-17T08:00:00Z"),
             thread("week", at: "2026-11-14T08:00:00Z"), thread("old", at: "2026-10-01T08:00:00Z")],
            by: "date", projects: [], now: now, calendar: utc)
        #expect(sections.map(\.id) == ["d:Today", "d:Yesterday", "d:This week", "d:Older"])
        #expect(sections.map { $0.threads.map(\.id) } == [["today"], ["yesterday"], ["week"], ["old"]])
        let withProject = sections.allSatisfy(\.showProject)
        #expect(withProject)
    }

    @Test func notGroupedIsOneList() {
        let sections = ThreadSection.group([thread("1"), thread("2")], by: "none", projects: [], now: now)
        #expect(sections.count == 1)
        let isPlain = sections.first?.header == nil
        #expect(isPlain)
        #expect(sections.first?.threads.count == 2)
    }

    /// Letter avatars get the same color as in the web app (hues from src/components/ProjectAvatar.tsx).
    @Test func avatarHuesMatchTheWeb() {
        let web: [String: Double] = ["shop-api": 43, "cart-demo": 72, "tool-choice-demo": 122, "myapp": 221,
                                     "Café ☕ 😀": 315]
        for (name, hue) in web { #expect(AvatarColor.hue(name) == hue, "\(name)") }
    }

    @MainActor @Test func svgIconsAreRecognized() {
        #expect(SVGIcon.isSVG(Data("<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8)))
        #expect(!SVGIcon.isSVG(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])))
    }

    /// The in-app banner: only for a thread that finished, failed, or started waiting for you.
    @Test func bannerEvents() {
        typealias Event = ThreadBanner.Event
        #expect(Event(was: .working, now: .completed, waitingFor: nil) == .done)
        #expect(Event(was: .waiting, now: .completed, waitingFor: nil) == .done)
        #expect(Event(was: .working, now: .failed, waitingFor: nil) == .failed)
        #expect(Event(was: .working, now: .waiting, waitingFor: "question") == .question)
        #expect(Event(was: .starting, now: .waiting, waitingFor: "approval") == .approval)
        #expect(Event(was: .working, now: .interrupted, waitingFor: nil) == nil)
        #expect(Event(was: .idle, now: .working, waitingFor: nil) == nil)
        #expect(Event(was: .completed, now: .completed, waitingFor: nil) == nil)
        #expect(Event(was: .idle, now: .completed, waitingFor: nil) == nil)
    }

    /// Dictation: on this iPhone by default (when it can), your computer once chosen in Settings.
    @Test func dictationEngineChoice() {
        let defaults = UserDefaults.standard
        let saved = defaults.string(forKey: DictationEngine.key)
        defer { defaults.set(saved, forKey: DictationEngine.key) }
        defaults.removeObject(forKey: DictationEngine.key)
        #expect(DictationEngine.current == (DictationEngine.onDeviceAvailable ? .iphone : .computer))
        defaults.set(DictationEngine.computer.rawValue, forKey: DictationEngine.key)
        #expect(DictationEngine.current == .computer)
        defaults.set(DictationEngine.iphone.rawValue, forKey: DictationEngine.key)
        #expect(DictationEngine.current == (DictationEngine.onDeviceAvailable ? .iphone : .computer))
    }

    /// While an agent works only the times change, several times a second: those are batched.
    @Test func onlyTimesDifferSpotsTimeOnlyChanges() {
        let old = [thread("a", at: "2026-11-18T11:00:00Z"), thread("b")]
        var newer = old
        newer[0].updatedAt = "2026-11-18T11:00:05Z"
        newer[0].lastMessageAt = "2026-11-18T11:00:05Z"
        #expect(AppModel.onlyTimesDiffer(old, newer))
        var status = newer
        status[0].status = .completed
        #expect(!AppModel.onlyTimesDiffer(old, status))
        var title = old
        title[1].title = "Renamed"
        #expect(!AppModel.onlyTimesDiffer(old, title))
        #expect(!AppModel.onlyTimesDiffer(old, Array(old.reversed())))
        #expect(!AppModel.onlyTimesDiffer(old, old + [thread("c")]))
    }
}
