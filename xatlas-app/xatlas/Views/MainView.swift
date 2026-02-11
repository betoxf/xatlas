import SwiftUI

struct MainView: View {
    @State private var state = AppState.shared

    var body: some View {
        HStack(spacing: 0) {
            // Sidebar
            SidebarView(state: state)
                .frame(width: 220)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.leading, 8)
                .padding(.vertical, 8)

            // Main content
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
