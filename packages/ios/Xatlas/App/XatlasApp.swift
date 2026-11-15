import SwiftUI

@main
struct XatlasApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { url in
                    if let link = RemoteLink(appURL: url) { model.pair(with: link) }
                }
        }
    }
}

/// The paired Mac, if any. Pairing replaces the previous Mac.
@MainActor
@Observable
final class AppModel {
    private let store = PairingStore()
    private(set) var link: RemoteLink?

    init() {
        link = store.load()
    }

    func pair(with link: RemoteLink) {
        try? store.save(link)
        self.link = link
    }

    func forget() {
        store.clear()
        link = nil
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let link = model.link {
                RemoteView(link: link)
                    .id(link)
            } else {
                HomeView()
            }
        }
        .animation(.smooth(duration: 0.3), value: model.link)
    }
}
