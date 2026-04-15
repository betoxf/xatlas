import Foundation

extension AppState {
    /// Adds a tab if it's not already open and selects it.
    func openTab(_ tab: TabItem) {
        if !tabs.contains(where: { $0.id == tab.id }) {
            tabs.append(tab)
        }
        selectedTab = tab
    }

    /// Closes a tab. For terminal tabs this delegates to
    /// `closeTerminalSession` so the backing tmux session is killed too;
    /// editor tabs are removed in place.
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

    /// Selects the tab at the given index (used by ⌘1–⌘9 hotkeys).
    @discardableResult
    func selectTab(at index: Int) -> Bool {
        guard tabs.indices.contains(index) else { return false }
        selectedTab = tabs[index]
        return true
    }

    // MARK: - Per-project workspace persistence

    func persistCurrentProjectWorkspace() {
        persistTabState(for: selectedProject?.id, tabs: tabs, selectedTab: selectedTab)
    }

    func workspaceState(for project: Project) -> AppStateProjectWorkspace {
        if let workspace = projectWorkspaces[project.id] {
            return workspace
        }

        let recoveredTabs = recoveredTerminalTabs(for: project.id)
        var workspace = AppStateProjectWorkspace()
        workspace.store(tabs: recoveredTabs, selectedTab: recoveredTabs.first)
        projectWorkspaces[project.id] = workspace
        return workspace
    }

    func recoveredTerminalTabs(for projectID: UUID) -> [TabItem] {
        TerminalService.shared.sessionsForProject(projectID).map {
            TabItem(id: $0.id, title: $0.displayTitle, kind: .terminal(sessionID: $0.id))
        }
    }

    func applyWorkspaceState(_ workspace: AppStateProjectWorkspace) {
        tabs = workspace.tabs
        selectedTab = workspace.selectedTab ?? workspace.tabs.first
    }

    func persistTabState(for projectID: UUID?, tabs: [TabItem], selectedTab: TabItem?) {
        guard let projectID else { return }
        var workspace = projectWorkspaces[projectID] ?? AppStateProjectWorkspace()
        workspace.store(tabs: tabs, selectedTab: selectedTab)
        projectWorkspaces[projectID] = workspace
    }

    func replacementTab(afterRemoving tabID: String, from tabs: [TabItem]) -> TabItem? {
        guard let removedIndex = tabs.firstIndex(where: { $0.id == tabID }) else {
            return tabs.last
        }

        var remainingTabs = tabs
        remainingTabs.remove(at: removedIndex)
        guard !remainingTabs.isEmpty else { return nil }
        return remainingTabs[min(removedIndex, remainingTabs.count - 1)]
    }
}
