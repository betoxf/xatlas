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

    var isLive: Bool {
        activityState != .exited
    }

    var activityDate: Date {
        lastActivityAt ?? updatedAt
    }

    var priorityRank: Int {
        if requiresAttention { return 0 }
        switch activityState {
        case .running: return 1
        case .idle: return 2
        case .detached: return 3
        case .error: return 4
        case .exited: return 5
        }
    }

    static func priorityOrder(_ lhs: TerminalSession, _ rhs: TerminalSession) -> Bool {
        if lhs.priorityRank != rhs.priorityRank {
            return lhs.priorityRank < rhs.priorityRank
        }
        if lhs.updatedAt != rhs.updatedAt {
            return lhs.updatedAt > rhs.updatedAt
        }
        if lhs.createdAt != rhs.createdAt {
            return lhs.createdAt > rhs.createdAt
        }
        return lhs.id > rhs.id
    }

    static func creationOrder(_ lhs: TerminalSession, _ rhs: TerminalSession) -> Bool {
        if lhs.createdAt != rhs.createdAt {
            return lhs.createdAt < rhs.createdAt
        }
        if lhs.updatedAt != rhs.updatedAt {
            return lhs.updatedAt < rhs.updatedAt
        }
        return lhs.id < rhs.id
    }

    static func recencyOrder(_ lhs: TerminalSession, _ rhs: TerminalSession) -> Bool {
        if lhs.activityDate != rhs.activityDate {
            return lhs.activityDate < rhs.activityDate
        }
        if lhs.updatedAt != rhs.updatedAt {
            return lhs.updatedAt < rhs.updatedAt
        }
        return lhs.createdAt < rhs.createdAt
    }
}

extension Notification.Name {
    static let xatlasTerminalSessionDidChange = Notification.Name("xatlas.terminalSessionDidChange")
    static let xatlasDetachedSessionCleanupDidRun = Notification.Name("xatlas.detachedSessionCleanupDidRun")
}
