import Foundation

extension AppState {
    func showProjectDashboard() {
        selectedSection = .projects
        projectSurfaceMode = .dashboard
    }

    func showProjectWorkspace() {
        selectedSection = .projects
        projectSurfaceMode = .workspace
        if selectedProject == nil, let firstProject = projects.first {
            switchToProject(firstProject)
        }
    }

    /// Opens the quick-view sheet for a project. Forces the dashboard
    /// surface so the sheet lays over the grid.
    @discardableResult
    func openProjectQuickView(id: UUID) -> Bool {
        guard projects.contains(where: { $0.id == id }) else { return false }
        selectedSection = .projects
        projectSurfaceMode = .dashboard
        dashboardQuickViewProjectID = id
        return true
    }

    func closeProjectQuickView() {
        dashboardQuickViewProjectID = nil
    }

    /// Returns the previously-selected terminal session for a project's
    /// quick-view, if any.
    func quickViewSelectedSessionID(for projectID: UUID) -> String? {
        projectWorkspaces[projectID]?.quickViewSessionID
    }

    /// Records which session is currently active in a project's
    /// quick-view, so reopening the sheet later restores it.
    func setQuickViewSelectedSessionID(_ sessionID: String?, for projectID: UUID) {
        var workspace = projectWorkspaces[projectID] ?? AppStateProjectWorkspace()
        workspace.quickViewSessionID = sessionID
        projectWorkspaces[projectID] = workspace
    }

    /// Picks the best session to surface for a given project given the
    /// available sessions — last-remembered quick-view session wins,
    /// then the active workspace tab if it belongs to this project,
    /// then the caller's fallback, then the first available.
    func preferredProjectSessionID(
        for projectID: UUID,
        availableSessionIDs: [String],
        fallbackSelection: String? = nil
    ) -> String? {
        guard !availableSessionIDs.isEmpty else { return nil }

        if let rememberedSessionID = quickViewSelectedSessionID(for: projectID),
           availableSessionIDs.contains(rememberedSessionID) {
            return rememberedSessionID
        }

        if selectedProject?.id == projectID,
           case .terminal(let sessionID) = selectedTab?.kind,
           availableSessionIDs.contains(sessionID) {
            return sessionID
        }

        if let fallbackSelection, availableSessionIDs.contains(fallbackSelection) {
            return fallbackSelection
        }

        return availableSessionIDs.first
    }
}
