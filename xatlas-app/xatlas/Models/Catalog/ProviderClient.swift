import Foundation

/// The set of agent CLI clients xatlas can detect and configure.
enum ProviderClient: String, CaseIterable, Identifiable {
    case codex
    case claude
    case cline
    case opencode
    case zai

    var id: String { rawValue }

    var label: String {
        switch self {
        case .codex: return "Codex"
        case .claude: return "Claude"
        case .cline: return "Cline"
        case .opencode: return "OpenCode"
        case .zai: return "Zai"
        }
    }

    /// True for clients whose MCP configuration xatlas can write to.
    var supportsManagedMCP: Bool {
        self == .codex || self == .claude
    }
}

/// Where xatlas can install a new MCP server entry.
enum MCPInstallTarget: String, CaseIterable, Identifiable {
    case codex
    case claude
    case project

    var id: String { rawValue }

    var label: String {
        switch self {
        case .codex: return "Codex"
        case .claude: return "Claude"
        case .project: return "Project"
        }
    }

    var detail: String {
        switch self {
        case .codex: return "~/.codex/config.toml"
        case .claude: return "~/.claude/settings.json"
        case .project: return ".mcp.json"
        }
    }
}

/// Whether a given client appears installed on this machine.
struct ProviderAvailability: Identifiable {
    let client: ProviderClient
    let isInstalled: Bool

    var id: String { client.id }
}
