import AppKit
import SwiftUI


private struct ProjectWorkspaceState {
    var tabs: [TabItem] = []
    var selectedTabID: String?
    var quickViewSessionID: String?

    var selectedTab: TabItem? {
        guard let selectedTabID else { return nil }
        return tabs.first(where: { $0.id == selectedTabID })
    }

    mutating func store(tabs: [TabItem], selectedTab: TabItem?) {
        self.tabs = tabs
        selectedTabID = selectedTab.flatMap { candidate in
            tabs.contains(where: { $0.id == candidate.id }) ? candidate.id : nil
        }

        let terminalSessionIDs = tabs.compactMap(\.terminalSessionID)
        guard !terminalSessionIDs.isEmpty else {
            quickViewSessionID = nil
            return
        }

        if let quickViewSessionID, terminalSessionIDs.contains(quickViewSessionID) {
            return
        }

        quickViewSessionID = selectedTab?.terminalSessionID ?? terminalSessionIDs.first
    }

    mutating func removeTerminalSession(_ sessionID: String) {
        let nextSelectedTabID = selectedTabID == sessionID
            ? replacementTabID(afterRemoving: sessionID, from: tabs)
            : selectedTab?.id
        let nextQuickViewSessionID = quickViewSessionID == sessionID
            ? replacementTerminalSessionID(afterRemoving: sessionID, from: tabs)
            : quickViewSessionID

        tabs.removeAll { $0.id == sessionID }
        selectedTabID = nextSelectedTabID
        quickViewSessionID = nextQuickViewSessionID
    }

    private func replacementTabID(afterRemoving tabID: String, from tabs: [TabItem]) -> String? {
        guard let removedIndex = tabs.firstIndex(where: { $0.id == tabID }) else {
            return tabs.last?.id
        }

        var remainingTabs = tabs
        remainingTabs.remove(at: removedIndex)
        guard !remainingTabs.isEmpty else { return nil }
        return remainingTabs[min(removedIndex, remainingTabs.count - 1)].id
    }

    private func replacementTerminalSessionID(afterRemoving sessionID: String, from tabs: [TabItem]) -> String? {
        let terminalIDs = tabs.compactMap(\.terminalSessionID)
        guard let removedIndex = terminalIDs.firstIndex(of: sessionID) else {
            return terminalIDs.last
        }

        var remainingTerminalIDs = terminalIDs
        remainingTerminalIDs.remove(at: removedIndex)
        guard !remainingTerminalIDs.isEmpty else { return nil }
        return remainingTerminalIDs[min(removedIndex, remainingTerminalIDs.count - 1)]
    }
}

@Observable
final class AppState: @unchecked Sendable {
    static let shared = AppState()

    var projects: [Project] = []
    var selectedSection: WorkspaceSection = .projects
    var selectedProject: Project?
    var selectedTab: TabItem? {
        didSet {
            persistActiveProjectTabState()
        }
    }
    var tabs: [TabItem] = [] {
        didSet {
            persistActiveProjectTabState()
        }
    }
    var isCommandBarFocused = false
    var isSettingsPresented = false
    var sidebarWidth: CGFloat = 220
    var projectSurfaceMode: ProjectSurfaceMode = .dashboard
    var dashboardQuickViewProjectID: UUID?
    var dashboardSearchQuery: String = ""
    var isDashboardSearchActive: Bool = false
    var activeToast: AppToast?
    private(set) var isProjectPickerPresented = false

    private var detachedCleanupObserver: NSObjectProtocol?
    private var toastDismissWorkItem: DispatchWorkItem?

    private var projectWorkspaces: [UUID: ProjectWorkspaceState] = [:]

    private init() {
        observeTerminalSessions()
        loadProjects()
    }

    deinit {
        if let detachedCleanupObserver {
            NotificationCenter.default.removeObserver(detachedCleanupObserver)
        }
        toastDismissWorkItem?.cancel()
    }

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

    @MainActor
    func presentProjectPicker() {
        guard !isProjectPickerPresented else { return }
        isProjectPickerPresented = true
        let additionBehavior: ProjectAdditionBehavior =
            selectedSection == .projects && projectSurfaceMode == .dashboard
            ? .stayOnDashboard
            : .selectInWorkspace

        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select a project folder"
        panel.prompt = "Open"

        let complete: (NSApplication.ModalResponse) -> Void = { [weak self, weak panel] response in
            guard let self else { return }
            defer { self.isProjectPickerPresented = false }
            guard response == .OK, let url = panel?.url else { return }
            self.addProject(
                name: url.lastPathComponent,
                path: url.path,
                behavior: additionBehavior
            )
        }

        if let window = NSApp.keyWindow ?? NSApp.mainWindow {
            panel.beginSheetModal(for: window, completionHandler: complete)
            return
        }

        NSApp.activate(ignoringOtherApps: true)
        let response = panel.runModal()
        complete(response)
    }

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
    func closeTerminalSession(_ sessionID: String, killTmux: Bool = true) -> Bool {
        guard let session = discardTerminalSession(sessionID, killTmux: killTmux) else { return false }
        showToast(
            title: "Terminal closed",
            message: session.displayTitle,
            style: .neutral
        )
        return true
    }

    func terminalNeedsCloseConfirmation(_ sessionID: String) -> Bool {
        guard let session = TerminalService.shared.session(id: sessionID) else { return false }
        return session.activityState == .running
    }

    func openTab(_ tab: TabItem) {
        if !tabs.contains(where: { $0.id == tab.id }) {
            tabs.append(tab)
        }
        selectedTab = tab
    }

    func openTextFile(path: String, initialContent: String? = nil) {
        let fileManager = FileManager.default
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)

        if !fileManager.fileExists(atPath: path), let initialContent {
            fileManager.createFile(atPath: path, contents: initialContent.data(using: .utf8))
        }

        openTab(
            TabItem(
                id: path,
                title: URL(fileURLWithPath: path).lastPathComponent,
                kind: .editor(filePath: path)
            )
        )
    }

    func revealInFinder(path: String, createIfMissing: Bool = false, isDirectory: Bool = false) {
        let fileManager = FileManager.default
        if createIfMissing {
            if isDirectory {
                try? fileManager.createDirectory(atPath: path, withIntermediateDirectories: true)
            } else {
                let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
                try? fileManager.createDirectory(atPath: directory, withIntermediateDirectories: true)
                if !fileManager.fileExists(atPath: path) {
                    fileManager.createFile(atPath: path, contents: Data())
                }
            }
        }

        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    @discardableResult
    func createTerminalForSelectedProject() -> TabItem {
        let tab = makeTerminalTab(for: selectedProject?.id, workingDirectory: selectedProject?.path)
        openTab(tab)
        selectedSection = .projects
        return tab
    }

    @discardableResult
    func createTerminal(for project: Project) -> TabItem {
        if selectedProject?.id != project.id {
            switchToProject(project, forceWorkspace: false)
        }
        return createTerminalForSelectedProject()
    }

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

    func quickViewSelectedSessionID(for projectID: UUID) -> String? {
        projectWorkspaces[projectID]?.quickViewSessionID
    }

    func setQuickViewSelectedSessionID(_ sessionID: String?, for projectID: UUID) {
        var workspace = projectWorkspaces[projectID] ?? ProjectWorkspaceState()
        workspace.quickViewSessionID = sessionID
        projectWorkspaces[projectID] = workspace
    }

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

    @discardableResult
    func runProjectBrief(for project: Project, provider: AISyncProvider? = nil) -> String? {
        let command = AISyncService.shared.projectBriefCommand(for: project.path, provider: provider)
        guard !command.isEmpty else { return nil }
        let tab = createTerminal(for: project)
        guard case .terminal(let sessionID) = tab.kind else { return nil }
        guard TerminalService.shared.sendCommand(command, to: sessionID) else { return nil }
        return sessionID
    }

    func closeTab(_ tab: TabItem) {
        switch tab.kind {
        case .terminal(let sessionID):
            _ = closeTerminalSession(sessionID, killTmux: true)
        case .editor:
            let replacementSelection = selectedTab?.id == tab.id
                ? replacementTab(afterRemoving: tab.id, from: tabs)
                : selectedTab
            tabs.removeAll { $0.id == tab.id }
            if selectedTab?.id == tab.id {
                selectedTab = replacementSelection
            }
        }
    }

    @discardableResult
    func selectTab(at index: Int) -> Bool {
        guard tabs.indices.contains(index) else { return false }
        selectedTab = tabs[index]
        return true
    }

    func terminalRequiresAttention(_ sessionID: String) -> Bool {
        TerminalService.shared.session(id: sessionID)?.requiresAttention ?? false
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

    @discardableResult
    func clearAttention(for sessionID: String) -> Bool {
        guard TerminalService.shared.session(id: sessionID) != nil else { return false }
        TerminalService.shared.clearAttention(for: sessionID)
        return true
    }

    @discardableResult
    func retryLastCommand(for sessionID: String) -> Bool {
        guard let session = TerminalService.shared.session(id: sessionID),
              let command = session.lastCommand?.trimmingCharacters(in: .whitespacesAndNewlines),
              !command.isEmpty else { return false }
        return TerminalService.shared.sendCommand(command, to: sessionID)
    }

    private func observeTerminalSessions() {
        detachedCleanupObserver = NotificationCenter.default.addObserver(
            forName: .xatlasDetachedSessionCleanupDidRun,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self else { return }
            let count = note.userInfo?["count"] as? Int ?? 0
            guard count > 0 else { return }
            self.showToast(
                title: "Cleaned old terminals",
                message: "Removed \(count) detached session\(count == 1 ? "" : "s")",
                style: .warning
            )
        }
    }

    func showToast(title: String, message: String? = nil, style: AppToastStyle = .neutral) {
        let toast = AppToast(title: title, message: message, style: style)
        activeToast = toast

        toastDismissWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard self?.activeToast?.id == toast.id else { return }
            withAnimation(.easeOut(duration: 0.18)) {
                self?.activeToast = nil
            }
        }
        toastDismissWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.6, execute: workItem)
    }

    @discardableResult
    private func discardTerminalSession(_ sessionID: String, killTmux: Bool) -> TerminalSession? {
        guard let session = TerminalService.shared.session(id: sessionID) else { return nil }

        let replacementSelection = selectedTab?.id == sessionID
            ? replacementTab(afterRemoving: sessionID, from: tabs)
            : selectedTab
        tabs.removeAll { $0.id == sessionID }
        if selectedTab?.id == sessionID {
            selectedTab = replacementSelection
        }

        for projectID in projectWorkspaces.keys {
            guard var workspace = projectWorkspaces[projectID] else { continue }
            workspace.removeTerminalSession(sessionID)
            projectWorkspaces[projectID] = workspace
        }

        TerminalService.shared.removeSession(sessionID, killTmux: killTmux)
        return session
    }

    private func makeTerminalTab(for projectID: UUID?, workingDirectory: String?) -> TabItem {
        let session = TerminalService.shared.createSession(projectID: projectID, workingDirectory: workingDirectory)
        return TabItem(id: session.id, title: session.displayTitle, kind: .terminal(sessionID: session.id))
    }

    private func persistCurrentProjectWorkspace() {
        persistTabState(for: selectedProject?.id, tabs: tabs, selectedTab: selectedTab)
    }

    private func workspaceState(for project: Project) -> ProjectWorkspaceState {
        if let workspace = projectWorkspaces[project.id] {
            return workspace
        }

        let recoveredTabs = recoveredTerminalTabs(for: project.id)
        var workspace = ProjectWorkspaceState()
        workspace.store(tabs: recoveredTabs, selectedTab: recoveredTabs.first)
        projectWorkspaces[project.id] = workspace
        return workspace
    }

    private func recoveredTerminalTabs(for projectID: UUID) -> [TabItem] {
        TerminalService.shared.sessionsForProject(projectID).map {
            TabItem(id: $0.id, title: $0.displayTitle, kind: .terminal(sessionID: $0.id))
        }
    }

    private func applyWorkspaceState(_ workspace: ProjectWorkspaceState) {
        tabs = workspace.tabs
        selectedTab = workspace.selectedTab ?? workspace.tabs.first
    }

    private func persistActiveProjectTabState() {
        persistCurrentProjectWorkspace()
    }

    private func persistTabState(for projectID: UUID?, tabs: [TabItem], selectedTab: TabItem?) {
        guard let projectID else { return }
        var workspace = projectWorkspaces[projectID] ?? ProjectWorkspaceState()
        workspace.store(tabs: tabs, selectedTab: selectedTab)
        projectWorkspaces[projectID] = workspace
    }

    private func replacementTab(afterRemoving tabID: String, from tabs: [TabItem]) -> TabItem? {
        guard let removedIndex = tabs.firstIndex(where: { $0.id == tabID }) else {
            return tabs.last
        }

        var remainingTabs = tabs
        remainingTabs.remove(at: removedIndex)
        guard !remainingTabs.isEmpty else { return nil }
        return remainingTabs[min(removedIndex, remainingTabs.count - 1)]
    }

}

