import Foundation

/// The top-level navigation section currently shown in the sidebar.
enum WorkspaceSection: String, CaseIterable, Identifiable {
    case projects
    case mcp
    case automations
    case skills

    var id: String { rawValue }

    var title: String {
        switch self {
        case .projects: return "Projects"
        case .mcp: return "MCP"
        case .automations: return "Automations"
        case .skills: return "Skills"
        }
    }
}
