import SwiftUI

struct MainView: View {
    @State private var state = AppState.shared

    private let windowBg = Color(nsColor: NSColor(white: 0.93, alpha: 1.0))

    var body: some View {
        HStack(spacing: 10) {
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

            VStack(spacing: 0) {
                Spacer().frame(height: 38)
                ToolbarView(state: state)
                ContentAreaView(state: state)
            }
            .padding(.trailing, 10)
            .padding(.bottom, 10)
        }
        .background(windowBg)
        .onAppear {
            if let project = state.selectedProject {
                state.switchToProject(project)
            } else if state.tabs.isEmpty {
                if let recovered = TerminalService.shared.sessions.first {
                    let tab = TabItem(
                        id: recovered.id,
                        title: recovered.displayTitle,
                        kind: .terminal(sessionID: recovered.id)
                    )
                    state.openTab(tab)
                } else {
                    let session = TerminalService.shared.createSession(workingDirectory: NSHomeDirectory())
                    let tab = TabItem(id: session.id, title: session.displayTitle, kind: .terminal(sessionID: session.id))
                    state.openTab(tab)
                }
            }
        }
    }
}

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
        if state.selectedSection != .projects {
            return state.selectedSection.title
        }
        return state.selectedTab?.title ?? "xatlas"
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
        .background(
            Circle()
                .fill(.white.opacity(isHovered ? 0.42 : 0.26))
                .overlay(
                    Circle().stroke(.white.opacity(0.28), lineWidth: 1)
                )
        )
        .onHover { isHovered = $0 }
        .scaleEffect(isHovered ? 1.03 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
    }
}
