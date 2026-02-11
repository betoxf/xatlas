import SwiftUI

struct MainView: View {
    @State private var state = AppState.shared

    // Slightly tinted background so white cards pop
    private let windowBg = Color(nsColor: NSColor(white: 0.93, alpha: 1.0))

    var body: some View {
        HStack(spacing: 10) {
            // Sidebar — floating white card
            SidebarView(state: state)
                .frame(width: 220)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(.white.opacity(0.75))
                        .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
                        .shadow(color: .black.opacity(0.06), radius: 4, y: 2)
                )
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .padding(.leading, 10)
                .padding(.vertical, 10)

            // Main content
            VStack(spacing: 0) {
                Spacer().frame(height: 38) // match traffic light height
                ToolbarView(state: state)
                ContentAreaView(state: state)
            }
            .padding(.trailing, 10)
            .padding(.bottom, 10)
        }
        .background(windowBg)
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

// MARK: - Toolbar with circular glass buttons

struct ToolbarView: View {
    @Bindable var state: AppState

    var body: some View {
        HStack(spacing: 12) {
            Text(toolbarTitle)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.primary)

            Spacer()

            HStack(spacing: 8) {
                ToolbarCircleButton(icon: "magnifyingglass")
                ToolbarCircleButton(icon: "square.and.arrow.up")
                ToolbarCircleButton(icon: "ellipsis")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var toolbarTitle: String {
        state.selectedTab?.title ?? "xatlas"
    }
}

private struct ToolbarCircleButton: View {
    let icon: String
    @State private var isHovered = false

    var body: some View {
        Button {} label: {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.primary.opacity(0.55))
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular, in: Circle())
        .onHover { isHovered = $0 }
        .scaleEffect(isHovered ? 1.08 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
    }
}
