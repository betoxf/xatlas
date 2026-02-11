import SwiftUI

@Observable
final class AppState {
    nonisolated(unsafe) static let shared = AppState()

    var projects: [Project] = []
    var selectedProject: Project?
    var selectedTab: TabItem?
    var tabs: [TabItem] = []
    var isCommandBarFocused = false
    var sidebarWidth: CGFloat = 220
    var pendingTerminalCommand: String?

    // Per-project tab storage
    private var projectTabs: [UUID: [TabItem]] = [:]
    private var projectSelectedTab: [UUID: TabItem] = [:]

    private init() {
        loadProjects()
    }

    func loadProjects() {
        projects = ProjectManager.shared.loadProjects()
        if selectedProject == nil {
            selectedProject = projects.first
        }
    }

    func addProject(name: String, path: String) {
        let project = Project(name: name, path: path)
        projects.append(project)
        switchToProject(project)
        ProjectManager.shared.saveProjects(projects)
    }

    func removeProject(_ project: Project) {
        projectTabs.removeValue(forKey: project.id)
        projectSelectedTab.removeValue(forKey: project.id)
        projects.removeAll { $0.id == project.id }
        if selectedProject?.id == project.id {
            if let first = projects.first {
                switchToProject(first)
            } else {
                selectedProject = nil
                tabs = []
                selectedTab = nil
            }
        }
        ProjectManager.shared.saveProjects(projects)
    }

    func switchToProject(_ project: Project) {
        guard selectedProject?.id != project.id else { return }

        // Save current
        if let current = selectedProject {
            projectTabs[current.id] = tabs
            projectSelectedTab[current.id] = selectedTab
        }

        selectedProject = project

        // Restore
        if let saved = projectTabs[project.id] {
            tabs = saved
            selectedTab = projectSelectedTab[project.id] ?? saved.first
        } else {
            let session = TerminalService.shared.createSession(title: "Terminal", projectID: project.id)
            let tab = TabItem(id: session.id, title: "Terminal", kind: .terminal(sessionID: session.id))
            tabs = [tab]
            selectedTab = tab
            projectTabs[project.id] = tabs
        }
    }

    func openTab(_ tab: TabItem) {
        if !tabs.contains(where: { $0.id == tab.id }) {
            tabs.append(tab)
        }
        selectedTab = tab
    }

    func closeTab(_ tab: TabItem) {
        tabs.removeAll { $0.id == tab.id }
        if selectedTab?.id == tab.id {
            selectedTab = tabs.last
        }
    }
}

struct TabItem: Identifiable, Equatable {
    let id: String
    let title: String
    let kind: TabKind

    enum TabKind: Equatable {
        case terminal(sessionID: String)
        case editor(filePath: String)
    }
}
