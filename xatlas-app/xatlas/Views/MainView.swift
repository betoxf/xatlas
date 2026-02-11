import SwiftUI

struct MainView: View {
    @State private var state = AppState.shared
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView(state: state)
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 300)
        } detail: {
            ContentAreaView(state: state)
        }
        .onAppear {
            if state.tabs.isEmpty {
                let session = TerminalService.shared.createSession(
                    projectID: state.selectedProject?.id
                )
                let tab = TabItem(
                    id: session.id,
                    title: session.title,
                    kind: .terminal(sessionID: session.id)
                )
                state.openTab(tab)
            }
        }
    }
}
