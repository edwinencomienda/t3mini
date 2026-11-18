import Foundation
import Testing
@testable import T3Mini

struct LiveUpdateTests {
    func decode(_ json: String) throws -> LiveUpdate {
        try JSONDecoder().decode(LiveUpdate.self, from: Data(json.utf8))
    }

    let threadJSON = """
    {"id":"t1","title":"Fix bug","provider":"claude","cwd":"/p","status":"working","approvals":[],
     "messages":[{"id":"m1","role":"user","text":"hi","createdAt":"2026-01-01T00:00:00.000Z"},
                 {"id":"m2","role":"assistant","text":"Hel","createdAt":"2026-01-01T00:00:01.000Z"}],
     "activities":[],"extraField":{"ignored":true}}
    """

    @Test func missingKeysMeanUnchanged() throws {
        let update = try decode(#"{"projects":[]}"#)
        #expect(update.threads == nil)
        #expect(update.projects == [])
        #expect(update.thread == nil) // absent: unchanged
        #expect(update.threadPatch == nil)
    }

    @Test func nullThreadIsPresent() throws {
        let update = try decode(#"{"thread":null}"#)
        #expect(update.thread == .some(nil))
    }

    @Test func appliesPatches() throws {
        let thread = try #require(try decode("{\"thread\":\(threadJSON)}").thread ?? nil)
        #expect(thread.messages.count == 2)
        #expect(thread.info.status == .working)
        // The reply grows, and a step starts.
        let patch = try #require(try decode("""
        {"threadPatch":{"id":"t1",
          "messages":{"count":2,"changed":[[1,{"id":"m2","role":"assistant","text":"Hello!","createdAt":"2026-01-01T00:00:01.000Z"}]]},
          "activities":{"count":1,"changed":[[0,{"id":"a1","label":"Run","summary":"bun test","status":"running"}]]}}}
        """).threadPatch)
        let next = try #require(patch.apply(to: thread))
        #expect(next.messages[1].text == "Hello!")
        #expect(next.messages[0] == thread.messages[0])
        #expect(next.activities.first?.line == "Run · bun test")
        // A patch for another thread, or one with a gap, can't be applied.
        let gap = try #require(try decode(#"{"threadPatch":{"id":"t1","messages":{"count":5,"changed":[[4,{"id":"m5","role":"user","text":"x","createdAt":"x"}]]}}}"#).threadPatch)
        #expect(gap.apply(to: thread) == nil)
        var other = thread
        other.info = ThreadInfo(id: "t2", title: "", provider: .codex, cwd: "", status: .idle, approvals: [])
        #expect(patch.apply(to: other) == nil)
    }

    @Test func unknownStatusStillDecodes() throws {
        let update = try decode(#"{"threads":[{"id":"t","title":"x","provider":"claude","cwd":"/","status":"brand-new","updatedAt":"2026"}]}"#)
        #expect(update.threads?.first?.status == .unknown)
    }

    @Test func parsesServerSentEvents() {
        var parser = EventStreamParser()
        #expect(parser.feed(": keepalive") == nil)
        #expect(parser.feed("") == nil)
        #expect(parser.feed("data: {\"a\":1}") == nil)
        #expect(parser.feed("") == "{\"a\":1}")
        #expect(parser.feed("data:x") == nil)
        #expect(parser.feed("data: y") == nil)
        #expect(parser.feed("") == "x\ny")
    }
}
