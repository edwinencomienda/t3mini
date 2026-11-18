import SwiftUI

@main
struct T3MiniApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                #if DEBUG
                .task { await pairFromLaunchEnvironment() }
                #endif
        }
    }

    #if DEBUG
    /// Debug builds only, for testing in the simulator without typing: pairs with the link in
    /// T3MINI_PAIR_LINK (`SIMCTL_CHILD_T3MINI_PAIR_LINK=… xcrun simctl launch …`). Opens a thread
    /// by id from T3MINI_OPEN_THREAD. Never in release builds.
    private func pairFromLaunchEnvironment() async {
        let environment = ProcessInfo.processInfo.environment
        if let link = environment["T3MINI_PAIR_LINK"], !model.isPaired {
            do { try await model.pair(with: link) } catch { print("Pairing failed: \(error.localizedDescription)") }
        }
        if let id = environment["T3MINI_OPEN_THREAD"] { model.pendingOpen = id }
    }
    #endif
}
