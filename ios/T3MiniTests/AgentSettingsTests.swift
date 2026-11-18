import Foundation
import Testing
@testable import T3Mini

struct AgentSettingsTests {
    let models = [
        ModelOption(id: "gpt-sol", label: "Sol", efforts: ["low", "medium", "high"], defaultEffort: "low",
                    isDefault: true, serviceTiers: [.init(id: "priority", label: "Fast")]),
        ModelOption(id: "gpt-mini", label: "Mini", efforts: ["low"], isDefault: false),
    ]

    @Test func keepsChoicesTheModelSupports() {
        let choice = AgentChoice(provider: .codex, model: "gpt-mini", effort: "high", serviceTier: "priority",
                                 permissionMode: "auto")
        let fitted = choice.fitted(to: models)
        #expect(fitted.model == "gpt-mini")
        #expect(fitted.effort == "") // Mini has no "high"
        #expect(fitted.serviceTier == "") // nor a fast tier
        #expect(fitted.permissionMode == "auto")
        let gone = AgentChoice(provider: .codex, model: "retired", effort: "medium", serviceTier: "priority",
                               permissionMode: "auto").fitted(to: models)
        #expect(gone.model == "") // back to the default (Sol), which has both
        #expect(gone.effort == "medium")
        #expect(gone.serviceTier == "priority")
    }

    @Test func labelsLikeTheWebApp() {
        #expect(AgentChoice.effortLabel("") == "Default")
        #expect(AgentChoice.effortLabel("xhigh") == "Extra high")
        #expect(AgentChoice.effortLabel("max") == "Max")
        #expect(PermissionMode.named("full-access")?.label == "Full access")
        #expect(PermissionMode.all.count == 4)
    }

    @Test func readsAThreadsSettingsAndWorktree() throws {
        let json = #"{"id":"t","title":"x","provider":"codex","cwd":"/p","model":"gpt-sol","effort":"high","permissionMode":"auto","serviceTier":"priority","worktree":{"path":"/w","branch":"t3m/fix-login","base":"abc","repo":"/p","setupMs":1},"status":"idle","approvals":[]}"#
        let info = try JSONDecoder().decode(ThreadInfo.self, from: Data(json.utf8))
        #expect(info.settings == AgentChoice(provider: .codex, model: "gpt-sol", effort: "high", serviceTier: "priority",
                                             permissionMode: "auto"))
        #expect(info.worktree?.branch == "t3m/fix-login")
        let git = try JSONDecoder().decode(GitInfo.self, from: Data(#"{"branch":"main","url":"https://github.com/example/app"}"#.utf8))
        #expect(git.branch == "main")
    }
}

import UIKit

struct ImagePrepTests {
    @Test func shrinksBigPhotosToJpeg() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let big = UIGraphicsImageRenderer(size: CGSize(width: 4032, height: 3024), format: format).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4032, height: 3024))
        }
        let png = try #require(big.pngData())
        let prepared = try #require(ImagePrep.prepare(png))
        let out = try #require(UIImage(data: prepared.jpeg))
        #expect(max(out.size.width, out.size.height) == 2048)
        #expect(prepared.jpeg.starts(with: [0xFF, 0xD8])) // JPEG
        #expect(prepared.jpeg.count < 4_000_000)
        #expect(max(prepared.preview.size.width, prepared.preview.size.height) <= 160)
        #expect(ImagePrep.prepare(Data("not an image".utf8)) == nil)
    }
}
