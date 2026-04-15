import SwiftUI

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
                .animation(XatlasMotion.layout, value: state.dashboardQuickViewProjectID)
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
    @State private var terminalService = TerminalService.shared
    @FocusState private var isSearchFocused: Bool

    private var isDashboard: Bool {
        state.selectedSection == .projects && state.projectSurfaceMode == .dashboard
    }

    var body: some View {
        HStack(spacing: 10) {
            if isDashboard {
                Text("Projects")
                    .font(XatlasFont.largeTitle)
                    .foregroundStyle(.primary)

                Text("Overview")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            } else {
                Text(toolbarTitle)
                    .font(XatlasFont.title)
                    .foregroundStyle(.primary)
            }

            if state.isDashboardSearchActive && isDashboard {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextField("Filter projects…", text: $state.dashboardSearchQuery)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, weight: .medium))
                        .focused($isSearchFocused)
                        .onSubmit {
                            if state.dashboardSearchQuery.isEmpty {
                                state.isDashboardSearchActive = false
                            }
                        }
                        .onExitCommand {
                            state.dashboardSearchQuery = ""
                            state.isDashboardSearchActive = false
                        }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .fill(.white.opacity(0.5))
                )
                .xatlasFocusRing(isFocused: isSearchFocused)
                .frame(maxWidth: 200)
                .onChange(of: state.isDashboardSearchActive) { _, active in
                    if active { isSearchFocused = true }
                }
            }

            Spacer()

            HStack(spacing: 8) {
                ToolbarCircleButton(icon: "magnifyingglass") {
                    state.isDashboardSearchActive.toggle()
                    if !state.isDashboardSearchActive {
                        state.dashboardSearchQuery = ""
                    }
                }
                ToolbarCircleButton(icon: "square.and.arrow.up") {
                    AppUpdateService.shared.performPrimaryAction(interactive: true)
                }
                ToolbarCircleButton(icon: "ellipsis") {}

                if isDashboard {
                    Button {
                        state.presentProjectPicker()
                    } label: {
                        Label("Add Project", systemImage: "plus")
                            .font(XatlasFont.captionEmphasized)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(
                                RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                                    .fill(.white.opacity(0.48))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                                            .strokeBorder(.white.opacity(0.40), lineWidth: 0.6)
                                    )
                            )
                    }
                    .buttonStyle(.plain)
                    .xatlasPressEffect()
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .overlay(alignment: .bottom) {
            xatlasFadingDivider()
                .padding(.horizontal, 14)
        }
    }

    private var toolbarTitle: String {
        if state.selectedSection != .projects {
            return state.selectedSection.title
        }
        return state.selectedTab?.resolvedTitle(using: terminalService) ?? "xatlas"
    }
}

private struct ToolbarCircleButton: View {
    let icon: String
    let action: () -> Void
    @State private var isHovered = false

    init(icon: String, action: @escaping () -> Void = {}) {
        self.icon = icon
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.primary.opacity(0.55))
                .frame(width: XatlasLayout.controlSize, height: XatlasLayout.controlSize)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(isHovered ? XatlasSurface.controlFillHovered : XatlasSurface.controlFill)
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .stroke(.white.opacity(0.34), lineWidth: 1)
                )
        )
        .onHover { isHovered = $0 }
        .scaleEffect(isHovered ? 1.03 : 1.0)
        .animation(XatlasMotion.hover, value: isHovered)
        .xatlasPressEffect()
    }
}
