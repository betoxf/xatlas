import Foundation

enum TerminalActivityState: String, Codable {
    case idle
    case running
    case detached
    case exited
    case error

    var label: String {
        switch self {
        case .idle: "Ready"
        case .running: "Running"
        case .detached: "Detached"
        case .exited: "Exited"
        case .error: "Error"
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
    var isActive: Bool
    var activityState: TerminalActivityState
    var requiresAttention: Bool
    var lastCommand: String?
    var semanticTaskKey: String?
    var lastActivityAt: Date?
    var createdAt: Date
    var updatedAt: Date

    var displayTitle: String {
        pinnedTitle ?? title
    }

    // CodingKeys with defaults for optional/missing fields
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tmuxSessionName = try c.decodeIfPresent(String.self, forKey: .tmuxSessionName) ?? ""
        title = try c.decode(String.self, forKey: .title)
        pinnedTitle = try c.decodeIfPresent(String.self, forKey: .pinnedTitle)
        projectID = try c.decodeIfPresent(UUID.self, forKey: .projectID)
        workingDirectory = try c.decodeIfPresent(String.self, forKey: .workingDirectory)
        currentDirectory = try c.decodeIfPresent(String.self, forKey: .currentDirectory)
        isActive = try c.decodeIfPresent(Bool.self, forKey: .isActive) ?? true
        activityState = try c.decodeIfPresent(TerminalActivityState.self, forKey: .activityState) ?? .idle
        requiresAttention = try c.decodeIfPresent(Bool.self, forKey: .requiresAttention) ?? false
        lastCommand = try c.decodeIfPresent(String.self, forKey: .lastCommand)
        semanticTaskKey = try c.decodeIfPresent(String.self, forKey: .semanticTaskKey)
        lastActivityAt = try c.decodeIfPresent(Date.self, forKey: .lastActivityAt)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? .now
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .now
    }
}
