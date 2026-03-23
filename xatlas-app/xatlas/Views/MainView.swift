import SwiftUI

struct MainView: View {
    @State private var state = AppState.shared

    private let windowBg = Color(nsColor: NSColor(white: 0.93, alpha: 1.0))

    private var quickViewProject: Project? {
        guard let projectID = state.dashboardQuickViewProjectID else { return nil }
        return state.projects.first(where: { $0.id == projectID })
    }

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
        .overlay {
            if let project = quickViewProject {
                Color.black.opacity(0.25)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {
                        state.closeProjectQuickView()
                    }

                ProjectQuickViewSheet(project: project, state: state)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .shadow(color: .black.opacity(0.18), radius: 40, y: 12)
                    .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: state.dashboardQuickViewProjectID)
        .overlay(alignment: .bottomTrailing) {
            if let toast = state.activeToast {
                AppToastView(toast: toast)
                    .padding(.trailing, 18)
                    .padding(.bottom, 18)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .sheet(isPresented: $state.isSettingsPresented) {
            AppSettingsView()
        }
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

private struct AppToastView: View {
    let toast: AppToast

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(accentColor)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(toast.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary)

                if let message = toast.message, !message.isEmpty {
                    Text(message)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.82))
                .shadow(color: .black.opacity(0.1), radius: 14, y: 6)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(.white.opacity(0.45), lineWidth: 1)
        )
    }

    private var accentColor: Color {
        switch toast.style {
        case .neutral:
            return .secondary.opacity(0.7)
        case .success:
            return .green.opacity(0.82)
        case .warning:
            return .orange.opacity(0.82)
        case .error:
            return .red.opacity(0.82)
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
        if state.projectSurfaceMode == .dashboard {
            return "Projects"
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
