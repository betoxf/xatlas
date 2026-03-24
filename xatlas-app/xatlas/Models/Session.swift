import Foundation

enum TerminalActivityState: String, Codable {
    case idle
    case running
    case detached
    case exited
    case error

    var label: String {
        switch self {
        case .idle: return "Ready"
        case .running: return "Running"
        case .detached: return "Detached"
        case .exited: return "Exited"
        case .error: return "Error"
        }
    }
}

struct TerminalSession: Identifiable, Codable, Equatable {
    let id: String
    let tmuxSessionName: String
    var title: String
    var pinnedTitle: String?
    var projectID: UUID?
    var workingDirectory: String?
    var currentDirectory: String?
    var isActive: Bool = true
    var activityState: TerminalActivityState = .idle
    var requiresAttention: Bool = false
    var lastCommand: String?
    var semanticTaskKey: String?
    var lastActivityAt: Date?
    var createdAt: Date = .now
    var updatedAt: Date = .now

    var displayTitle: String {
        pinnedTitle ?? title
    }

    var displayDirectory: String {
        let path = currentDirectory ?? workingDirectory ?? NSHomeDirectory()
        return path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }
}

extension Notification.Name {
    static let xatlasTerminalSessionDidChange = Notification.Name("xatlas.terminalSessionDidChange")
    static let xatlasDetachedSessionCleanupDidRun = Notification.Name("xatlas.detachedSessionCleanupDidRun")
}
