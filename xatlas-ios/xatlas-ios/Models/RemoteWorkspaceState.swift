import Foundation

/// Workspace state snapshot decoded from the desktop's /api/state endpoint.
/// Uses manual decoding to handle the hand-rolled JSON format from the desktop.
struct RemoteWorkspaceState {
    var selectedProjectId: String
    var selectedTabId: String
    var selectedSessionId: String
    var projectSurface: String
    var projects: [Project]
    var sessions: [RemoteSessionInfo]
    var operatorEvents: [RemoteEventInfo]

    static let empty = RemoteWorkspaceState(
        selectedProjectId: "",
        selectedTabId: "",
        selectedSessionId: "",
        projectSurface: "workspace",
        projects: [],
        sessions: [],
        operatorEvents: []
    )
}

struct RemoteSessionInfo: Identifiable, Codable, Equatable {
    let id: String
    let title: String
    let tmuxSession: String
    let projectId: String
    let cwd: String
    let state: String
    let attention: Bool
    let lastCommand: String?

    var activityState: TerminalActivityState {
        TerminalActivityState(rawValue: state) ?? .idle
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        tmuxSession = try c.decodeIfPresent(String.self, forKey: .tmuxSession) ?? ""
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "idle"
        attention = try c.decodeIfPresent(Bool.self, forKey: .attention) ?? false
        lastCommand = try c.decodeIfPresent(String.self, forKey: .lastCommand)
    }
}

struct RemoteEventInfo: Identifiable, Codable, Equatable {
    let id: String
    let kind: String
    let sessionId: String
    let sessionTitle: String?
    let projectId: String?
    let command: String
    let details: String?
    let timestamp: String?
}

extension RemoteWorkspaceState: Codable {
    enum CodingKeys: String, CodingKey {
        case selectedProjectId, selectedTabId, selectedSessionId, projectSurface
        case projects, sessions, operatorEvents
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        selectedProjectId = try c.decodeIfPresent(String.self, forKey: .selectedProjectId) ?? ""
        selectedTabId = try c.decodeIfPresent(String.self, forKey: .selectedTabId) ?? ""
        selectedSessionId = try c.decodeIfPresent(String.self, forKey: .selectedSessionId) ?? ""
        projectSurface = try c.decodeIfPresent(String.self, forKey: .projectSurface) ?? "workspace"
        projects = try c.decodeIfPresent([Project].self, forKey: .projects) ?? []
        sessions = try c.decodeIfPresent([RemoteSessionInfo].self, forKey: .sessions) ?? []
        operatorEvents = try c.decodeIfPresent([RemoteEventInfo].self, forKey: .operatorEvents) ?? []
    }
}
