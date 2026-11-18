import SwiftUI

/// Pairing until this phone is connected to a computer, then the thread list.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.isPaired {
                ThreadListView()
            } else {
                PairView()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back to the app: catch up at once instead of waiting for the stream to retry.
            if phase == .active { Task { await model.refresh() } }
        }
    }
}
