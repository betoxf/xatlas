import SwiftUI

/// Root composition for the xatlas window. Wires the sidebar panel and
/// the content panel side-by-side, layers the project quick-view sheet
/// and the toast overlay on top, and routes settings to its dedicated
/// surface.
struct MainView: View {
    @State private var state = AppState.shared

    private var quickViewProject: Project? {
        guard let projectID = state.dashboardQuickViewProjectID else { return nil }
        return state.projects.first(where: { $0.id == projectID })
    }

    var body: some View {
        Group {
            if state.isSettingsPresented {
                AppSettingsView(state: state)
            } else {
                ZStack {
                    HStack(spacing: XatlasLayout.panelGap) {
                        SidebarView(state: state)
                            .frame(width: XatlasLayout.sidebarWidth)
                            .xatlasPanelSurface()
                            .padding(.leading, XatlasLayout.windowPadding)
                            .padding(.vertical, XatlasLayout.windowPadding)

                        VStack(spacing: 0) {
                            ToolbarView(state: state)
                            ContentAreaView(state: state)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .xatlasPanelSurface()
                        .padding(.trailing, XatlasLayout.windowPadding)
                        .padding(.vertical, XatlasLayout.windowPadding)
                    }

                    QuickViewOverlay(project: quickViewProject, state: state)
                }
            }
        }
        .background(XatlasSurface.windowBackground)
        .overlay(alignment: .bottomTrailing) {
            if let toast = state.activeToast {
                AppToastView(toast: toast)
                    .padding(.trailing, 18)
                    .padding(.bottom, 18)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onAppear {
            if let project = state.selectedProject {
                state.switchToProject(project, forceWorkspace: false)
            }
        }
    }
}

/// Modal scrim + drop-down sheet for the per-project quick view.
private struct QuickViewOverlay: View {
    let project: Project?
    @Bindable var state: AppState

    var body: some View {
        ZStack {
            if let project {
                Color.black.opacity(0.25)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {
                        state.closeProjectQuickView()
                    }

                ProjectQuickViewSheet(
                    project: project,
                    state: state,
                    isPresented: true
                )
                .id(project.id)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .shadow(color: .black.opacity(0.18), radius: 40, y: 12)
            }
        }
    }
}

/// Bottom-right toast bubble with a colored status dot, title, and
/// optional secondary message.
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
        case .neutral: return .secondary.opacity(0.7)
        case .success: return .green.opacity(0.82)
        case .warning: return .orange.opacity(0.82)
        case .error: return .red.opacity(0.82)
        }
    }
}
