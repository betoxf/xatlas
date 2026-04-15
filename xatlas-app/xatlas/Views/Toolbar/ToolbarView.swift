import SwiftUI

/// The bar at the top of the content panel. Shows the current
/// section/tab title, an inline dashboard search field when active, and
/// a row of action buttons (search toggle, share/update, ellipsis,
/// add-project on the dashboard).
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
                searchField
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
                    addProjectButton
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

    private var searchField: some View {
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

    private var addProjectButton: some View {
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

    private var toolbarTitle: String {
        if state.selectedSection != .projects {
            return state.selectedSection.title
        }
        return state.selectedTab?.resolvedTitle(using: terminalService) ?? "xatlas"
    }
}
