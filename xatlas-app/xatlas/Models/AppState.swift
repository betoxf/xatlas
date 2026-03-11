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

    private var terminalSessionObserver: NSObjectProtocol?

    // Per-project tab storage
    private var projectTabs: [UUID: [TabItem]] = [:]
    private var projectSelectedTab: [UUID: TabItem] = [:]

    private init() {
        observeTerminalSessions()
        loadProjects()
    }

    deinit {
        if let terminalSessionObserver {
            NotificationCenter.default.removeObserver(terminalSessionObserver)
        }
    }

    func loadProjects() {
        projects = ProjectManager.shared.loadProjects()
        TerminalService.shared.rehydrateSessions(projects: projects)
        if selectedProject == nil {
            selectedProject = projects.first
        }
    }

    func addProject(name: String, path: String) {
        let project = Project(name: name, path: path)
        projects.append(project)
        TerminalService.shared.rehydrateSessions(projects: projects)
        switchToProject(project)
        ProjectManager.shared.saveProjects(projects)
    }

    func removeProject(_ project: Project) {
        projectTabs.removeValue(forKey: project.id)
        projectSelectedTab.removeValue(forKey: project.id)
        projects.removeAll { $0.id == project.id }
        TerminalService.shared.rehydrateSessions(projects: projects)
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
        if selectedProject?.id == project.id, !tabs.isEmpty {
            return
        }

        if let current = selectedProject {
            projectTabs[current.id] = tabs
            projectSelectedTab[current.id] = selectedTab
        }

        selectedProject = project

        if let saved = projectTabs[project.id] {
            tabs = saved
            selectedTab = projectSelectedTab[project.id] ?? saved.first
        } else {
            let recovered = TerminalService.shared.sessionsForProject(project.id)
            if !recovered.isEmpty {
                tabs = recovered.map {
                    TabItem(id: $0.id, title: $0.displayTitle, kind: .terminal(sessionID: $0.id))
                }
                selectedTab = tabs.first
            } else {
                let session = TerminalService.shared.createSession(projectID: project.id, workingDirectory: project.path)
                let tab = TabItem(id: session.id, title: session.displayTitle, kind: .terminal(sessionID: session.id))
                tabs = [tab]
                selectedTab = tab
            }
            projectTabs[project.id] = tabs
        }
    }

    @discardableResult
    func selectProject(id: UUID) -> Bool {
        guard let project = projects.first(where: { $0.id == id }) else { return false }
        switchToProject(project)
        return true
    }

    @discardableResult
    func openTerminalSession(_ sessionID: String) -> Bool {
        guard let session = TerminalService.shared.session(id: sessionID) else { return false }

        if let projectID = session.projectID {
            _ = selectProject(id: projectID)
        }

        let tab = TabItem(id: session.id, title: session.displayTitle, kind: .terminal(sessionID: session.id))
        openTab(tab)
        return true
    }

    @discardableResult
    func closeTerminalSession(_ sessionID: String, killTmux: Bool = false) -> Bool {
        guard TerminalService.shared.session(id: sessionID) != nil else { return false }

        tabs.removeAll { $0.id == sessionID }
        if selectedTab?.id == sessionID {
            selectedTab = tabs.last
        }

        for projectID in projectTabs.keys {
            guard var storedTabs = projectTabs[projectID] else { continue }
            storedTabs.removeAll { $0.id == sessionID }
            projectTabs[projectID] = storedTabs
            if projectSelectedTab[projectID]?.id == sessionID {
                projectSelectedTab[projectID] = storedTabs.last
            }
        }

        TerminalService.shared.removeSession(sessionID, killTmux: killTmux)
        return true
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

    private func observeTerminalSessions() {
        terminalSessionObserver = NotificationCenter.default.addObserver(
            forName: .xatlasTerminalSessionDidChange,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self,
                  let session = note.userInfo?["session"] as? TerminalSession else { return }
            self.syncTitles(for: session)
        }
    }

    private func syncTitles(for session: TerminalSession) {
        syncTitles(in: &tabs, for: session)

        if let selectedTab, selectedTab.id == session.id {
            self.selectedTab = tabs.first(where: { $0.id == session.id }) ?? selectedTab
        }

        for projectID in projectTabs.keys {
            guard var storedTabs = projectTabs[projectID] else { continue }
            syncTitles(in: &storedTabs, for: session)
            projectTabs[projectID] = storedTabs
            if projectSelectedTab[projectID]?.id == session.id {
                projectSelectedTab[projectID] = storedTabs.first(where: { $0.id == session.id })
            }
        }
    }

    private func syncTitles(in collection: inout [TabItem], for session: TerminalSession) {
        for index in collection.indices {
            guard case .terminal(let sessionID) = collection[index].kind, sessionID == session.id else { continue }
            collection[index].title = session.displayTitle
        }
    }
}

struct TabItem: Identifiable, Equatable {
    let id: String
    var title: String
    let kind: TabKind

    enum TabKind: Equatable {
        case terminal(sessionID: String)
        case editor(filePath: String)
    }
}
