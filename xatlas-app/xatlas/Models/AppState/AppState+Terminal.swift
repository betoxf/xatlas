import Foundation

extension AppState {
    /// Brings an existing terminal session into the active workspace —
    /// switching projects if needed and opening (or selecting) a tab.
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

    /// Closes a terminal session by id. Pairs with `discardTerminalSession`
    /// (which does the actual cleanup) and emits a toast on success.
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

    /// Whether closing a terminal should prompt the user — true while a
    /// command is actively running.
    func terminalNeedsCloseConfirmation(_ sessionID: String) -> Bool {
        guard let session = TerminalService.shared.session(id: sessionID) else { return false }
        return session.activityState == .running
    }

    /// Spawns a fresh terminal tab for the currently selected project.
    @discardableResult
    func createTerminalForSelectedProject() -> TabItem {
        let tab = makeTerminalTab(for: selectedProject?.id, workingDirectory: selectedProject?.path)
        openTab(tab)
        selectedSection = .projects
        return tab
    }

    /// Spawns a fresh terminal tab for an arbitrary project, switching
    /// to that project first if it isn't already active.
    @discardableResult
    func createTerminal(for project: Project) -> TabItem {
        if selectedProject?.id != project.id {
            switchToProject(project, forceWorkspace: false)
        }
        return createTerminalForSelectedProject()
    }

    func terminalRequiresAttention(_ sessionID: String) -> Bool {
        TerminalService.shared.session(id: sessionID)?.requiresAttention ?? false
    }

    @discardableResult
    func clearAttention(for sessionID: String) -> Bool {
        guard TerminalService.shared.session(id: sessionID) != nil else { return false }
        TerminalService.shared.clearAttention(for: sessionID)
        return true
    }

    /// Re-runs whatever command was last sent on the given session, if
    /// any. Used by the workspace operator-feed retry button.
    @discardableResult
    func retryLastCommand(for sessionID: String) -> Bool {
        guard let session = TerminalService.shared.session(id: sessionID),
              let command = session.lastCommand?.trimmingCharacters(in: .whitespacesAndNewlines),
              !command.isEmpty else { return false }
        return TerminalService.shared.sendCommand(command, to: sessionID)
    }

    /// Spawns a terminal for `project` and feeds it the AI sync's
    /// "project brief" command. Returns the new session id.
    @discardableResult
    func runProjectBrief(for project: Project, provider: AISyncProvider? = nil) -> String? {
        let command = AISyncService.shared.projectBriefCommand(for: project.path, provider: provider)
        guard !command.isEmpty else { return nil }
        let tab = createTerminal(for: project)
        guard case .terminal(let sessionID) = tab.kind else { return nil }
        guard TerminalService.shared.sendCommand(command, to: sessionID) else { return nil }
        return sessionID
    }

    /// Internal helper — performs the actual session removal: drops the
    /// matching tab(s), updates each project's quick-view bookkeeping,
    /// and asks TerminalService to release the underlying session.
    @discardableResult
    func discardTerminalSession(_ sessionID: String, killTmux: Bool) -> TerminalSession? {
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

    /// Builds a TabItem wrapping a freshly-created terminal session.
    func makeTerminalTab(for projectID: UUID?, workingDirectory: String?) -> TabItem {
        let session = TerminalService.shared.createSession(projectID: projectID, workingDirectory: workingDirectory)
        return TabItem(id: session.id, title: session.displayTitle, kind: .terminal(sessionID: session.id))
    }
}
