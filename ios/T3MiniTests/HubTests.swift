import Foundation
import Testing
@testable import T3Mini

struct HubTests {
    let vps = HubMachine(id: "abc123", name: "vps")

    @Test func idsCarryTheirMachine() {
        let id = Hub.id("abc123", "t1")
        #expect(id == "m~abc123~t1")
        #expect(Hub.parse(id)?.machine == "abc123")
        #expect(Hub.parse(id)?.id == "t1")
        // A folder path keeps its own "~" and slashes.
        let folder = Hub.id("abc123", "/home/me/~app")
        #expect(Hub.local(folder) == "/home/me/~app")
        // The computer's own ids are left alone.
        #expect(Hub.parse("t1") == nil)
        #expect(Hub.local("/Users/me/app") == "/Users/me/app")
        #expect(Hub.parse("m~~t1") == nil)
    }

    @Test func mapsAMachinesThreadsAndProjects() throws {
        let summary = ThreadSummary(id: "t1", title: "Fix", provider: .claude, cwd: "/srv/app", status: .completed,
                                    updatedAt: "x", parentId: "lead")
        let mapped = summary.onMachine(vps)
        #expect(mapped.id == "m~abc123~t1")
        #expect(mapped.cwd == "m~abc123~/srv/app")
        #expect(mapped.parentId == "m~abc123~lead")
        #expect(mapped.machine == "vps")
        let project = ProjectSummary(path: "/srv/app", name: "app").onMachine(vps)
        #expect(project.path == mapped.cwd)
        #expect(project.listName == "app · vps")
        // A whole thread and a patch for it line up with the list's ids, so patches apply.
        let json = #"{"id":"t1","title":"Fix","provider":"claude","cwd":"/srv/app","status":"working","approvals":[],"messages":[],"activities":[]}"#
        let thread = try JSONDecoder().decode(ChatThread.self, from: Data(json.utf8)).onMachine("abc123")
        #expect(thread.id == mapped.id)
        #expect(thread.info.cwd == mapped.cwd)
        let patchJSON = #"{"id":"t1","rest":{"id":"t1","title":"Fixed","provider":"claude","cwd":"/srv/app","status":"completed","approvals":[]}}"#
        let patch = try JSONDecoder().decode(ThreadPatch.self, from: Data(patchJSON.utf8)).onMachine("abc123")
        let next = try #require(patch.apply(to: thread))
        #expect(next.info.title == "Fixed")
        #expect(next.info.cwd == mapped.cwd)
    }
}
