import Foundation

enum OperatorEventKind: String, Codable {
    case commandStarted
    case commandFinished
    case commandFailed
}

struct OperatorEvent: Identifiable, Codable, Equatable {
    let id: UUID
    let timestamp: Date
    let kind: OperatorEventKind
    let sessionID: String
    let sessionTitle: String
    let projectID: UUID?
    let command: String
    let details: String?
}
