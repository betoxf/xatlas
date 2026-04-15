import Foundation

/// A single tab in the workspace area — either a terminal session or an
/// editor pane bound to a file path.
struct TabItem: Identifiable, Equatable {
    let id: String
    var title: String
    let kind: TabKind

    enum TabKind: Equatable {
        case terminal(sessionID: String)
        case editor(filePath: String)
    }

    var terminalSessionID: String? {
        guard case .terminal(let sessionID) = kind else { return nil }
        return sessionID
    }

    func resolvedTitle(using terminalService: TerminalService = .shared) -> String {
        terminalSessionID.map(terminalService.displayTitle(for:)) ?? title
    }
}
