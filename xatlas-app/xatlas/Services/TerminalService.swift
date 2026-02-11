import Foundation

@Observable
final class TerminalService {
    nonisolated(unsafe) static let shared = TerminalService()

    var sessions: [TerminalSession] = []

    func createSession(title: String = "Terminal", projectID: UUID? = nil, workingDirectory: String? = nil) -> TerminalSession {
        let session = TerminalSession(title: title, projectID: projectID)
        sessions.append(session)
        return session
    }

    func removeSession(_ id: String) {
        sessions.removeAll { $0.id == id }
    }

    func sessionsForProject(_ projectID: UUID?) -> [TerminalSession] {
        guard let projectID else { return sessions }
        return sessions.filter { $0.projectID == projectID }
    }
}
