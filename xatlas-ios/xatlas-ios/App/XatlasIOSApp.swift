import SwiftUI

@main
struct XatlasIOSApp: App {
    @State private var appState = AppConnectionState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
        }
    }
}

struct RootView: View {
    @Environment(AppConnectionState.self) private var appState

    var body: some View {
        switch appState.phase {
        case .discovering:
            DiscoveryView()
        case .pairing(let host):
            PairingView(host: host)
        case .connected:
            DashboardView()
        }
    }
}
