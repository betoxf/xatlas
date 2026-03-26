import Foundation

enum OperatorAutonomyLevel: String, Codable, CaseIterable, Identifiable {
    case askHuman
    case balanced
    case drive

    var id: String { rawValue }

    var title: String {
        switch self {
        case .askHuman:
            return "Ask First"
        case .balanced:
            return "Balanced"
        case .drive:
            return "Drive"
        }
    }

    var summary: String {
        switch self {
        case .askHuman:
            return "Pause on most decisions and ask before continuing."
        case .balanced:
            return "Handle clear next steps alone and escalate product decisions."
        case .drive:
            return "Keep moving until blocked, then escalate only major decisions."
        }
    }
}

enum ProjectOperatorStatus: String, Codable {
    case unscanned
    case scanning
    case ready
    case running
    case needsConfirmation
    case failed

    var label: String {
        switch self {
        case .unscanned:
            return "Unscanned"
        case .scanning:
            return "Scanning"
        case .ready:
            return "Ready"
        case .running:
            return "Running"
        case .needsConfirmation:
            return "Needs Confirmation"
        case .failed:
            return "Error"
        }
    }
}

enum OperatorConsoleRole: String, Equatable {
    case assistant
    case user
}

struct OperatorConsoleMessage: Identifiable, Equatable {
    let id: UUID
    let role: OperatorConsoleRole
    let text: String
    let projectID: UUID?
    let createdAt: Date

    init(
        id: UUID = UUID(),
        role: OperatorConsoleRole,
        text: String,
        projectID: UUID? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.projectID = projectID
        self.createdAt = createdAt
    }
}

struct ProjectOperatorState: Codable, Equatable {
    let projectID: UUID
    var autonomy: OperatorAutonomyLevel
    var status: ProjectOperatorStatus
    var overview: String
    var lastWorkedOn: String
    var recentCommits: [String]
    var nextSuggestedAction: String
    var questionForHuman: String?
    var canContinueAutonomously: Bool
    var currentGoal: String?
    var operatorPrompt: String
    var managedSessionID: String?
    var automaticContinuationCount: Int
    var lastScanAt: Date?
    var lastManagedRunAt: Date?
    var lastResultSummary: String?
    var lastError: String?

    init(
        projectID: UUID,
        autonomy: OperatorAutonomyLevel = .drive,
        status: ProjectOperatorStatus = .unscanned,
        overview: String = "",
        lastWorkedOn: String = "",
        recentCommits: [String] = [],
        nextSuggestedAction: String = "",
        questionForHuman: String? = nil,
        canContinueAutonomously: Bool = false,
        currentGoal: String? = nil,
        operatorPrompt: String = "",
        managedSessionID: String? = nil,
        automaticContinuationCount: Int = 0,
        lastScanAt: Date? = nil,
        lastManagedRunAt: Date? = nil,
        lastResultSummary: String? = nil,
        lastError: String? = nil
    ) {
        self.projectID = projectID
        self.autonomy = autonomy
        self.status = status
        self.overview = overview
        self.lastWorkedOn = lastWorkedOn
        self.recentCommits = recentCommits
        self.nextSuggestedAction = nextSuggestedAction
        self.questionForHuman = questionForHuman
        self.canContinueAutonomously = canContinueAutonomously
        self.currentGoal = currentGoal
        self.operatorPrompt = operatorPrompt
        self.managedSessionID = managedSessionID
        self.automaticContinuationCount = automaticContinuationCount
        self.lastScanAt = lastScanAt
        self.lastManagedRunAt = lastManagedRunAt
        self.lastResultSummary = lastResultSummary
        self.lastError = lastError
    }
}
