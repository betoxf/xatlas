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

    init(
        id: UUID = UUID(),
        timestamp: Date = .now,
        kind: OperatorEventKind,
        sessionID: String,
        sessionTitle: String,
        projectID: UUID?,
        command: String,
        details: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.kind = kind
        self.sessionID = sessionID
        self.sessionTitle = sessionTitle
        self.projectID = projectID
        self.command = command
        self.details = details
    }
}

@Observable
final class OperatorEventStore: @unchecked Sendable {
    static let shared = OperatorEventStore()

    private(set) var events: [OperatorEvent] = []
    private let maxEvents = 250

    func record(
        kind: OperatorEventKind,
        session: TerminalSession,
        command: String,
        details: String? = nil
    ) {
        let cleanedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedCommand.isEmpty else { return }

        let cleanedDetails = details?.trimmingCharacters(in: .whitespacesAndNewlines)
        let event = OperatorEvent(
            kind: kind,
            sessionID: session.id,
            sessionTitle: session.displayTitle,
            projectID: session.projectID,
            command: cleanedCommand,
            details: cleanedDetails?.isEmpty == false ? cleanedDetails : nil
        )

        events.insert(event, at: 0)
        if events.count > maxEvents {
            events.removeLast(events.count - maxEvents)
        }
    }

    func recentEvents(limit: Int = 40) -> [OperatorEvent] {
        Array(events.prefix(limit))
    }
}
