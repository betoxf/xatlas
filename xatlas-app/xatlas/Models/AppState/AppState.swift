import AppKit
import SwiftUI

/// Per-project workspace state remembered across project switches —
/// which tabs are open, which one is selected, and the last terminal
/// session preferred by the project's quick-view sheet. Internal so that
/// tab/quick-view extensions can mutate it.
struct AppStateProjectWorkspace {
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

/// The singleton observable state at the heart of the UI. Everything
/// SwiftUI views read through `state.*` lives here.
///
/// To keep this class's surface manageable, methods are split across
/// concern-focused extensions in this folder:
///
///   - `AppState+Projects.swift`       — load/add/remove/switch projects
///   - `AppState+Tabs.swift`           — open/close/select tabs + per-project
///                                       workspace persistence
///   - `AppState+Terminal.swift`       — terminal session orchestration
///                                       (delegates to TerminalService)
///   - `AppState+QuickView.swift`      — dashboard mode + quick-view sheet
///                                       state + preferred session selection
///   - `AppState+Editor.swift`         — openTextFile / revealInFinder
///   - `AppState+Toast.swift`          — toast notification queue
///   - `AppState+ProjectPicker.swift`  — NSOpenPanel project picker
///
/// All stored properties stay here so the @Observable macro can wire up
/// change tracking. Helper methods called across extensions are marked
/// `internal` (no access modifier) since Swift `private` is per-file.
@Observable
final class AppState: @unchecked Sendable {
    static let shared = AppState()

    // MARK: - Project + section state
    var projects: [Project] = []
    var selectedSection: WorkspaceSection = .projects
    var selectedProject: Project?

    // MARK: - Workspace tab state
    var selectedTab: TabItem? {
        didSet { persistActiveProjectTabState() }
    }
    var tabs: [TabItem] = [] {
        didSet { persistActiveProjectTabState() }
    }

    // MARK: - UI mode flags
    var isCommandBarFocused = false
    var isSettingsPresented = false
    var sidebarWidth: CGFloat = 220
    var projectSurfaceMode: ProjectSurfaceMode = .dashboard

    // MARK: - Dashboard surface state
    var dashboardQuickViewProjectID: UUID?
    var dashboardSearchQuery: String = ""
    var isDashboardSearchActive: Bool = false

    // MARK: - Toast
    var activeToast: AppToast?

    // MARK: - Project picker
    /// Set by AppState+ProjectPicker; views read it but don't mutate it.
    var isProjectPickerPresented = false

    // MARK: - Internal bookkeeping
    var projectWorkspaces: [UUID: AppStateProjectWorkspace] = [:]
    var detachedCleanupObserver: NSObjectProtocol?
    var toastDismissWorkItem: DispatchWorkItem?

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

    /// Subscribes to terminal session lifecycle notifications. Currently
    /// just surfaces a toast when detached sessions are reaped.
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

    /// Allows `tabs` and `selectedTab` didSet observers to delegate to the
    /// tabs extension without needing access to file-private helpers.
    func persistActiveProjectTabState() {
        persistTabState(for: selectedProject?.id, tabs: tabs, selectedTab: selectedTab)
    }
}
