import AppKit
import SwiftUI

enum WorkspaceSection: String, CaseIterable, Identifiable {
    case projects
    case mcp
    case automations
    case skills

    var id: String { rawValue }

    var title: String {
        switch self {
        case .projects: return "Projects"
        case .mcp: return "MCP"
        case .automations: return "Automations"
        case .skills: return "Skills"
        }
    }
}

enum ProjectSurfaceMode: String, CaseIterable, Identifiable {
    case workspace
    case dashboard

    var id: String { rawValue }
}

enum ProjectAdditionBehavior {
    case selectInWorkspace
    case stayOnDashboard
}

enum AppToastStyle: Equatable {
    case neutral
    case success
    case warning
    case error
}

struct AppToast: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String?
    let style: AppToastStyle
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
    var terminalEventVersion: Int = 0
    var projectSurfaceMode: ProjectSurfaceMode = .dashboard
    var dashboardQuickViewProjectID: UUID?
    var dashboardSearchQuery: String = ""
    var isDashboardSearchActive: Bool = false
    var activeToast: AppToast?
    private(set) var isProjectPickerPresented = false

    private var terminalSessionObserver: NSObjectProtocol?
    private var detachedCleanupObserver: NSObjectProtocol?
    private var toastDismissWorkItem: DispatchWorkItem?

    // Per-project tab storage
    private var projectTabs: [UUID: [TabItem]] = [:]
    private var projectSelectedTab: [UUID: TabItem] = [:]
    private var projectQuickViewSelectedSessionID: [UUID: String] = [:]

    private init() {
        observeTerminalSessions()
        loadProjects()
    }

    deinit {
        if let terminalSessionObserver {
            NotificationCenter.default.removeObserver(terminalSessionObserver)
        }
        if let detachedCleanupObserver {
            NotificationCenter.default.removeObserver(detachedCleanupObserver)
        }
        toastDismissWorkItem?.cancel()
    }

    func loadProjects() {
        projects = ProjectManager.shared.loadProjects()
        TerminalService.shared.rehydrateSessions(projects: projects)
        if selectedProject == nil {
            selectedProject = projects.first
        }
        if let selectedProject {
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
        let activeSessionCount = TerminalService.shared
            .sessionsForProject(project.id)
            .filter { $0.activityState != .exited }
            .count
        let sessionIDs = TerminalService.shared.sessionsForProject(project.id).map(\.id)
        sessionIDs.forEach { _ = discardTerminalSession($0, killTmux: true) }

        if dashboardQuickViewProjectID == project.id {
            dashboardQuickViewProjectID = nil
        }
        projectTabs.removeValue(forKey: project.id)
        projectSelectedTab.removeValue(forKey: project.id)
        projectQuickViewSelectedSessionID.removeValue(forKey: project.id)
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

        if let current = selectedProject {
            persistTabState(for: current.id, tabs: tabs, selectedTab: selectedTab)
        }

        selectedProject = project

        if let saved = projectTabs[project.id] {
            if saved.isEmpty {
                tabs = []
                selectedTab = nil
            } else {
                tabs = saved
                selectedTab = restoredTab(from: projectSelectedTab[project.id], within: saved) ?? saved.first
            }
        } else {
            let recovered = TerminalService.shared.sessionsForProject(project.id)
            if !recovered.isEmpty {
                tabs = recovered.map {
                    TabItem(id: $0.id, title: $0.displayTitle, kind: .terminal(sessionID: $0.id))
                }
                selectedTab = tabs.first
            } else {
                tabs = []
                selectedTab = nil
            }
            persistTabState(for: project.id, tabs: tabs, selectedTab: selectedTab)
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
        projectQuickViewSelectedSessionID[projectID]
    }

    func setQuickViewSelectedSessionID(_ sessionID: String?, for projectID: UUID) {
        projectQuickViewSelectedSessionID[projectID] = sessionID
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
        terminalSessionObserver = NotificationCenter.default.addObserver(
            forName: .xatlasTerminalSessionDidChange,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self,
                  let session = note.userInfo?["session"] as? TerminalSession else { return }
            self.terminalEventVersion &+= 1
            self.syncTitles(for: session)
        }

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

    private func syncTitles(for session: TerminalSession) {
        syncTitles(in: &tabs, for: session)

        if let selectedTab, selectedTab.id == session.id {
            self.selectedTab = tabs.first(where: { $0.id == session.id }) ?? selectedTab
        }

        for projectID in projectTabs.keys {
            guard var storedTabs = projectTabs[projectID] else { continue }
            let before = storedTabs
            syncTitles(in: &storedTabs, for: session)
            guard storedTabs != before else { continue }
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

        for projectID in projectTabs.keys {
            guard var storedTabs = projectTabs[projectID] else { continue }
            let replacementSelection = projectSelectedTab[projectID]?.id == sessionID
                ? replacementTab(afterRemoving: sessionID, from: storedTabs)
                : restoredTab(from: projectSelectedTab[projectID], within: storedTabs)
            let replacementQuickViewSessionID = projectQuickViewSelectedSessionID[projectID] == sessionID
                ? replacementTerminalSessionID(afterRemoving: sessionID, from: storedTabs)
                : projectQuickViewSelectedSessionID[projectID]
            storedTabs.removeAll { $0.id == sessionID }
            projectTabs[projectID] = storedTabs
            if projectSelectedTab[projectID]?.id == sessionID {
                projectSelectedTab[projectID] = replacementSelection
            }
            if projectQuickViewSelectedSessionID[projectID] == sessionID {
                projectQuickViewSelectedSessionID[projectID] = replacementQuickViewSessionID
            }
        }

        TerminalService.shared.removeSession(sessionID, killTmux: killTmux)
        return session
    }

    private func makeTerminalTab(for projectID: UUID?, workingDirectory: String?) -> TabItem {
        let session = TerminalService.shared.createSession(projectID: projectID, workingDirectory: workingDirectory)
        return TabItem(id: session.id, title: session.displayTitle, kind: .terminal(sessionID: session.id))
    }

    private func persistActiveProjectTabState() {
        persistTabState(for: selectedProject?.id, tabs: tabs, selectedTab: selectedTab)
    }

    private func persistTabState(for projectID: UUID?, tabs: [TabItem], selectedTab: TabItem?) {
        guard let projectID else { return }
        projectTabs[projectID] = tabs
        let resolvedSelection = restoredTab(from: selectedTab, within: tabs)
        projectSelectedTab[projectID] = resolvedSelection
        if case .terminal(let sessionID) = resolvedSelection?.kind {
            projectQuickViewSelectedSessionID[projectID] = sessionID
        }
    }

    private func restoredTab(from selectedTab: TabItem?, within tabs: [TabItem]) -> TabItem? {
        guard let selectedTab else { return nil }
        return tabs.first(where: { $0.id == selectedTab.id })
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

    private func replacementTerminalSessionID(afterRemoving sessionID: String, from tabs: [TabItem]) -> String? {
        let terminalIDs = tabs.compactMap { tab -> String? in
            guard case .terminal(let candidateSessionID) = tab.kind else { return nil }
            return candidateSessionID
        }

        guard let removedIndex = terminalIDs.firstIndex(of: sessionID) else {
            return terminalIDs.last
        }

        var remainingTerminalIDs = terminalIDs
        remainingTerminalIDs.remove(at: removedIndex)
        guard !remainingTerminalIDs.isEmpty else { return nil }
        return remainingTerminalIDs[min(removedIndex, remainingTerminalIDs.count - 1)]
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
