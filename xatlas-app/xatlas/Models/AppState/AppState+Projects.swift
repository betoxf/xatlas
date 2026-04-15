import Foundation

extension AppState {
    /// Loads projects from disk, primes terminal/operator services with
    /// them, and selects the first project if none is currently chosen.
    func loadProjects() {
        projects = ProjectManager.shared.loadProjects()
        TerminalService.shared.rehydrateSessions(projects: projects)
        ProjectOperatorService.shared.bootstrap(projects: projects)
        if selectedProject == nil {
            selectedProject = projects.first
        }
        if let selectedProject {
            switchToProject(selectedProject, forceWorkspace: false)
            FileTreeCache.shared.preload(rootPath: selectedProject.path)
        }
    }

    /// Adds a project, persists the catalog, and either jumps into its
    /// workspace or stays on the dashboard depending on the behavior.
    func addProject(
        name: String,
        path: String,
        behavior: ProjectAdditionBehavior = .selectInWorkspace
    ) {
        let project = Project(name: name, path: path)
        projects.append(project)
        TerminalService.shared.rehydrateSessions(projects: projects)
        switch behavior {
        case .selectInWorkspace:
            switchToProject(project)
        case .stayOnDashboard:
            switchToProject(project, forceWorkspace: false)
            projectSurfaceMode = .dashboard
        }
        ProjectManager.shared.saveProjects(projects)
        ProjectOperatorService.shared.syncProjects(projects)
        showToast(
            title: "Project added",
            message: project.name,
            style: .success
        )
    }

    /// Removes a project from the catalog and kills all of its terminal
    /// sessions. Returns the count of terminals that were closed.
    @discardableResult
    func removeProject(_ project: Project) -> Int {
        let activeSessionCount = projectLiveSessionCount(project.id)
        let sessionIDs = TerminalService.shared.sessionsForProject(project.id).map(\.id)
        sessionIDs.forEach { _ = discardTerminalSession($0, killTmux: true) }

        if dashboardQuickViewProjectID == project.id {
            dashboardQuickViewProjectID = nil
        }
        projectWorkspaces.removeValue(forKey: project.id)
        projects.removeAll { $0.id == project.id }
        TerminalService.shared.rehydrateSessions(projects: projects)
        if selectedProject?.id == project.id {
            if let first = projects.first {
                switchToProject(first, forceWorkspace: projectSurfaceMode == .workspace)
            } else {
                selectedProject = nil
                tabs = []
                selectedTab = nil
            }
        }
        ProjectManager.shared.saveProjects(projects)
        ProjectOperatorService.shared.syncProjects(projects)
        showToast(
            title: "Project closed",
            message: activeSessionCount > 0
                ? "\(project.name) • \(activeSessionCount) terminal\(activeSessionCount == 1 ? "" : "s") closed"
                : project.name,
            style: .warning
        )
        return activeSessionCount
    }

    /// Activates the given project, optionally forcing the workspace
    /// surface (vs leaving the user on the dashboard). Persists the
    /// previously-active project's tab state on the way out and applies
    /// the incoming project's stored workspace.
    func switchToProject(_ project: Project, forceWorkspace: Bool = true) {
        selectedSection = .projects
        if forceWorkspace {
            projectSurfaceMode = .workspace
        }
        FileTreeCache.shared.preload(rootPath: project.path)
        if selectedProject?.id == project.id, !tabs.isEmpty {
            return
        }

        persistCurrentProjectWorkspace()
        selectedProject = project
        applyWorkspaceState(workspaceState(for: project))
    }

    @discardableResult
    func selectProject(id: UUID) -> Bool {
        guard let project = projects.first(where: { $0.id == id }) else { return false }
        switchToProject(project)
        return true
    }

    func projectAttentionCount(_ projectID: UUID?) -> Int {
        TerminalService.shared.sessionsForProject(projectID).filter(\.requiresAttention).count
    }

    func projectLiveSessionCount(_ projectID: UUID?) -> Int {
        TerminalService.shared.liveSessionsForProject(projectID).count
    }

    func projectCloseWarningText(for project: Project) -> String {
        let count = projectLiveSessionCount(project.id)
        return "This will remove \(project.name) from xatlas and kill all \(count) terminal\(count == 1 ? "" : "s") plus their backing tmux session\(count == 1 ? "" : "s") everywhere."
    }
}
