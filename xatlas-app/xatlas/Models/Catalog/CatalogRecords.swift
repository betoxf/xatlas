import Foundation

/// A single MCP server entry discovered across user/project configs.
struct MCPServerRecord: Identifiable {
    let id: String
    let name: String
    let provider: CatalogProvider
    let scope: CatalogScope
    let origin: CatalogOrigin
    let sourcePath: String
    let owningProjectPath: String?
    let transportSummary: String
    let detailSummary: String
    let configuration: MCPConfiguration
}

/// A discovered skill — either a folder of skill files or a config entry.
struct SkillRecord: Identifiable {
    let id: String
    let name: String
    let provider: CatalogProvider
    let scope: CatalogScope
    let origin: CatalogOrigin
    let category: String
    let sourcePath: String
    let detailSummary: String
}

/// A discovered automation, scoped the same way as skills.
struct AutomationRecord: Identifiable {
    let id: String
    let name: String
    let provider: CatalogProvider
    let scope: CatalogScope
    let origin: CatalogOrigin
    let category: String
    let sourcePath: String
    let detailSummary: String
}

/// Aggregate result of a single catalog scan — everything the workspace
/// section needs to render the MCP / Skills / Automations panels.
struct AgentCatalogSnapshot {
    let mcpServers: [MCPServerRecord]
    let skills: [SkillRecord]
    let automations: [AutomationRecord]
    let availableProviders: [ProviderAvailability]
}
