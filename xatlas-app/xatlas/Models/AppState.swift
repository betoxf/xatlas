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
        selectedProject = project
        ProjectManager.shared.saveProjects(projects)
    }

    func removeProject(_ project: Project) {
        projects.removeAll { $0.id == project.id }
        if selectedProject?.id == project.id {
            selectedProject = projects.first
        }
        ProjectManager.shared.saveProjects(projects)
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
