import Foundation

enum CatalogProvider: String {
    case codex
    case claude
    case project

    var label: String { rawValue.capitalized }
}

enum CatalogScope: String {
    case user
    case project
    case local

    var label: String { rawValue.capitalized }
}

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

    var supportsManagedMCP: Bool {
        self == .codex || self == .claude
    }
}

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

struct ProviderAvailability: Identifiable {
    let client: ProviderClient
    let isInstalled: Bool

    var id: String { client.id }
}

struct MCPConfiguration {
    let url: String?
    let command: String?
    let args: [String]
    let env: [String: String]
    let cwd: String?
    let enabled: Bool?
    let required: Bool?
    let enabledTools: [String]
    let disabledTools: [String]
    let envVars: [String]
    let bearerTokenEnvVar: String?
    let httpHeaders: [String: String]
    let envHTTPHeaders: [String: String]
    let scopes: [String]
    let oauthResource: String?
    let startupTimeoutSec: Double?
    let startupTimeoutMS: Int?
    let toolTimeoutSec: Double?
    let rawJSONObject: [String: Any]?

    init(
        url: String? = nil,
        command: String? = nil,
        args: [String] = [],
        env: [String: String] = [:],
        cwd: String? = nil,
        enabled: Bool? = nil,
        required: Bool? = nil,
        enabledTools: [String] = [],
        disabledTools: [String] = [],
        envVars: [String] = [],
        bearerTokenEnvVar: String? = nil,
        httpHeaders: [String: String] = [:],
        envHTTPHeaders: [String: String] = [:],
        scopes: [String] = [],
        oauthResource: String? = nil,
        startupTimeoutSec: Double? = nil,
        startupTimeoutMS: Int? = nil,
        toolTimeoutSec: Double? = nil,
        rawJSONObject: [String: Any]? = nil
    ) {
        self.url = url
        self.command = command
        self.args = args
        self.env = env
        self.cwd = cwd
        self.enabled = enabled
        self.required = required
        self.enabledTools = enabledTools
        self.disabledTools = disabledTools
        self.envVars = envVars
        self.bearerTokenEnvVar = bearerTokenEnvVar
        self.httpHeaders = httpHeaders
        self.envHTTPHeaders = envHTTPHeaders
        self.scopes = scopes
        self.oauthResource = oauthResource
        self.startupTimeoutSec = startupTimeoutSec
        self.startupTimeoutMS = startupTimeoutMS
        self.toolTimeoutSec = toolTimeoutSec
        self.rawJSONObject = rawJSONObject
    }

    var transportSummary: String {
        if url != nil { return "HTTP" }
        if command != nil { return "stdio" }
        return "configured"
    }

    var detailSummary: String {
        if let url, !url.isEmpty {
            return url
        }

        let pieces = [command] + args
        return pieces.compactMap { $0 }.joined(separator: " ")
    }

    var jsonObject: [String: Any] {
        var object = rawJSONObject ?? [:]
        setJSONValue(&object, key: "url", value: url)
        setJSONValue(&object, key: "command", value: command)
        setJSONValue(&object, key: "args", value: args.isEmpty ? nil : args)
        setJSONValue(&object, key: "env", value: env.isEmpty ? nil : env)
        setJSONValue(&object, key: "cwd", value: cwd)
        setJSONValue(&object, key: "enabled", value: enabled)
        setJSONValue(&object, key: "required", value: required)
        setJSONValue(&object, key: "enabledTools", value: enabledTools.isEmpty ? nil : enabledTools)
        setJSONValue(&object, key: "disabledTools", value: disabledTools.isEmpty ? nil : disabledTools)
        setJSONValue(&object, key: "envVars", value: envVars.isEmpty ? nil : envVars)
        setJSONValue(&object, key: "bearerTokenEnvVar", value: bearerTokenEnvVar)
        setJSONValue(&object, key: "httpHeaders", value: httpHeaders.isEmpty ? nil : httpHeaders)
        setJSONValue(&object, key: "envHttpHeaders", value: envHTTPHeaders.isEmpty ? nil : envHTTPHeaders)
        setJSONValue(&object, key: "scopes", value: scopes.isEmpty ? nil : scopes)
        setJSONValue(&object, key: "oauthResource", value: oauthResource)
        setJSONValue(&object, key: "startupTimeoutSec", value: startupTimeoutSec)
        setJSONValue(&object, key: "startupTimeoutMs", value: startupTimeoutMS)
        setJSONValue(&object, key: "toolTimeoutSec", value: toolTimeoutSec)
        return object
    }

    private func setJSONValue(_ object: inout [String: Any], key: String, value: Any?) {
        if let value {
            object[key] = value
        } else {
            object.removeValue(forKey: key)
        }
    }
}

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

struct AgentCatalogSnapshot {
    let mcpServers: [MCPServerRecord]
    let skills: [SkillRecord]
    let automations: [AutomationRecord]
    let availableProviders: [ProviderAvailability]
}

private struct CodexMCPSection {
    let name: String
    let configuration: MCPConfiguration
}

enum CatalogOrigin {
    case config
    case folder
    case plugin
}

private struct ClaudePluginInstallation {
    let key: String
    let displayName: String
    let marketplace: String
    let scope: CatalogScope
    let projectPath: String?
    let installPath: String
    let description: String?
}

final class AgentCatalogService {
    nonisolated(unsafe) static let shared = AgentCatalogService()

    private let fileManager = FileManager.default
    private let homeDirectory = NSHomeDirectory()

    func snapshot(projectPath: String?) -> AgentCatalogSnapshot {
        AgentCatalogSnapshot(
            mcpServers: mcpServers(projectPath: projectPath),
            skills: skills(projectPath: projectPath),
            automations: automations(projectPath: projectPath),
            availableProviders: providerAvailability()
        )
    }

    func providerAvailability() -> [ProviderAvailability] {
        ProviderClient.allCases.map { client in
            ProviderAvailability(client: client, isInstalled: isInstalled(client))
        }
    }

    func availableInstallTargets(projectPath: String?) -> [MCPInstallTarget] {
        var targets: [MCPInstallTarget] = []
        if isInstalled(.codex) {
            targets.append(.codex)
        }
        if isInstalled(.claude) {
            targets.append(.claude)
        }
        if projectPath?.isEmpty == false {
            targets.append(.project)
        }
        return targets
    }

    @discardableResult
    func addMCP(
        named name: String,
        configuration: MCPConfiguration,
        targets: [MCPInstallTarget],
        projectPath: String?
    ) -> [MCPInstallTarget: Bool] {
        var results: [MCPInstallTarget: Bool] = [:]

        for target in targets {
            let ok: Bool
            switch target {
            case .codex:
                ok = upsertCodexServer(named: name, configuration: configuration, at: codexConfigPath)
            case .claude:
                ok = upsertJSONServer(
                    at: claudeSettingsPath,
                    keyPath: ["mcpServers"],
                    name: name,
                    configuration: configuration
                )
            case .project:
                guard let projectPath else {
                    results[target] = false
                    continue
                }
                ok = upsertProjectServer(
                    named: name,
                    configuration: configuration,
                    at: projectPath + "/.mcp.json"
                )
            }
            results[target] = ok
        }

        return results
    }

    @discardableResult
    func copyMCP(_ record: MCPServerRecord, to client: ProviderClient) -> Bool {
        switch client {
        case .codex:
            return upsertCodexServer(named: record.name, configuration: record.configuration, at: codexConfigPath)
        case .claude:
            return upsertJSONServer(
                at: claudeSettingsPath,
                keyPath: ["mcpServers"],
                name: record.name,
                configuration: record.configuration
            )
        case .cline, .opencode, .zai:
            return false
        }
    }

    @discardableResult
    func deleteMCP(_ record: MCPServerRecord) -> Bool {
        guard record.origin != .plugin else { return false }
        switch record.provider {
        case .codex:
            return removeCodexServer(named: record.name, at: record.sourcePath)
        case .claude:
            if record.scope == .project, let projectPath = record.owningProjectPath {
                return removeJSONServer(at: record.sourcePath, keyPath: ["projects", projectPath, "mcpServers"], name: record.name)
            }
            return removeJSONServer(at: record.sourcePath, keyPath: ["mcpServers"], name: record.name)
        case .project:
            return removeProjectMCPServer(named: record.name, at: record.sourcePath)
        }
    }

    @discardableResult
    func deleteSkill(_ record: SkillRecord) -> Bool {
        guard record.origin == .folder else { return false }
        let url = URL(fileURLWithPath: record.sourcePath)
        let skillDirectory = url.deletingLastPathComponent()
        do {
            try fileManager.removeItem(at: skillDirectory)
            return true
        } catch {
            return false
        }
    }

    @discardableResult
    func deleteAutomation(_ record: AutomationRecord) -> Bool {
        guard record.origin == .folder else { return false }
        do {
            try fileManager.removeItem(atPath: record.sourcePath)
            return true
        } catch {
            return false
        }
    }

    private var codexConfigPath: String { homeDirectory + "/.codex/config.toml" }
    private var claudeSettingsPath: String { homeDirectory + "/.claude/settings.json" }
    private var claudeStatePath: String { homeDirectory + "/.claude.json" }

    private func mcpServers(projectPath: String?) -> [MCPServerRecord] {
        var records: [MCPServerRecord] = []

        records += parseCodexMCPConfig(at: codexConfigPath, scope: .user)
        records += parseClaudeMCPJSON(at: claudeSettingsPath, keyPath: ["mcpServers"], provider: .claude, scope: .user)
        records += parseClaudeMCPJSON(at: claudeStatePath, keyPath: ["mcpServers"], provider: .claude, scope: .local)
        records += claudePluginMCPServers(projectPath: projectPath)

        if let projectPath, codexProjectIsTrusted(projectPath) {
            records += parseCodexMCPConfig(at: projectPath + "/.codex/config.toml", scope: .project)
        }
        if let projectPath {
            records += parseClaudeProjectState(at: claudeStatePath, projectPath: projectPath)
            records += parseProjectMCPJSON(at: projectPath + "/.mcp.json", projectPath: projectPath)
        }

        return records.sorted { lhs, rhs in
            if lhs.provider != rhs.provider { return lhs.provider.rawValue < rhs.provider.rawValue }
            if lhs.scope != rhs.scope { return lhs.scope.rawValue < rhs.scope.rawValue }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private func skills(projectPath: String?) -> [SkillRecord] {
        var records: [SkillRecord] = []
        records += scanSkillDirectory(root: homeDirectory + "/.codex/skills", provider: .codex, scope: .user, category: "Skill")
        records += parseCodexConfiguredSkills(at: codexConfigPath, scope: .user)
        records += scanSkillDirectory(root: homeDirectory + "/.claude/skills", provider: .claude, scope: .user, category: "Skill")
        if let projectPath, codexProjectIsTrusted(projectPath) {
            records += parseCodexConfiguredSkills(at: projectPath + "/.codex/config.toml", scope: .project)
        }
        if let projectPath {
            records += scanSkillDirectory(root: projectPath + "/.claude/skills", provider: .claude, scope: .project, category: "Skill")
        }
        records += claudePluginSkills(projectPath: projectPath)
        return records.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func automations(projectPath: String?) -> [AutomationRecord] {
        var records: [AutomationRecord] = []
        records += scanMarkdownDirectory(root: homeDirectory + "/.claude/commands", provider: .claude, scope: .user, category: "Command")
        records += scanMarkdownDirectory(root: homeDirectory + "/.claude/agents", provider: .claude, scope: .user, category: "Agent")
        records += parseClaudeHooks(at: claudeSettingsPath, provider: .claude, scope: .user, sourceLabel: "Claude settings")
        if let projectPath {
            records += scanMarkdownDirectory(root: projectPath + "/.claude/commands", provider: .claude, scope: .project, category: "Command")
            records += scanMarkdownDirectory(root: projectPath + "/.claude/agents", provider: .claude, scope: .project, category: "Agent")
        }
        records += claudePluginAutomations(projectPath: projectPath)
        return records.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func parseCodexMCPConfig(at path: String, scope: CatalogScope) -> [MCPServerRecord] {
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
        let sections = parseCodexSections(from: content)

        return sections.map { section in
            MCPServerRecord(
                id: "codex:\(section.name):\(path)",
                name: section.name,
                provider: .codex,
                scope: scope,
                origin: .config,
                sourcePath: path,
                owningProjectPath: nil,
                transportSummary: section.configuration.transportSummary,
                detailSummary: section.configuration.detailSummary.nonEmpty ?? "Configured in \(path)",
                configuration: section.configuration
            )
        }
    }

    private func parseClaudeMCPJSON(
        at path: String,
        keyPath: [String],
        provider: CatalogProvider,
        scope: CatalogScope
    ) -> [MCPServerRecord] {
        guard let root = parseJSONDictionary(at: path),
              let servers = nestedDictionary(root, keyPath: keyPath) else { return [] }

        return servers.compactMap { name, value -> MCPServerRecord? in
            guard let config = value as? [String: Any] else { return nil }
            let configuration = configuration(from: config)
            return MCPServerRecord(
                id: "\(provider.rawValue):\(scope.rawValue):\(name):\(path)",
                name: name,
                provider: provider,
                scope: scope,
                origin: .config,
                sourcePath: path,
                owningProjectPath: nil,
                transportSummary: configuration.transportSummary,
                detailSummary: configuration.detailSummary.nonEmpty ?? "Configured in \(path)",
                configuration: configuration
            )
        }
    }

    private func parseClaudeProjectState(at path: String, projectPath: String) -> [MCPServerRecord] {
        guard let root = parseJSONDictionary(at: path),
              let projects = root["projects"] as? [String: Any],
              let project = projects[projectPath] as? [String: Any],
              let servers = project["mcpServers"] as? [String: Any] else { return [] }

        return servers.compactMap { name, value -> MCPServerRecord? in
            guard let config = value as? [String: Any] else { return nil }
            let configuration = configuration(from: config)
            return MCPServerRecord(
                id: "claude:project:\(name):\(projectPath)",
                name: name,
                provider: .claude,
                scope: .project,
                origin: .config,
                sourcePath: path,
                owningProjectPath: projectPath,
                transportSummary: configuration.transportSummary,
                detailSummary: configuration.detailSummary.nonEmpty ?? "Configured for \(projectPath)",
                configuration: configuration
            )
        }
    }

    private func parseProjectMCPJSON(at path: String, projectPath: String) -> [MCPServerRecord] {
        guard let root = parseJSONDictionary(at: path) else { return [] }
        let servers = (root["mcpServers"] as? [String: Any]) ?? root

        return servers.compactMap { name, value -> MCPServerRecord? in
            guard let config = value as? [String: Any] else { return nil }
            let configuration = configuration(from: config)
            return MCPServerRecord(
                id: "project:mcp:\(name):\(path)",
                name: name,
                provider: .project,
                scope: .project,
                origin: .config,
                sourcePath: path,
                owningProjectPath: projectPath,
                transportSummary: configuration.transportSummary,
                detailSummary: configuration.detailSummary.nonEmpty ?? "Configured in .mcp.json",
                configuration: configuration
            )
        }
    }

    private func scanSkillDirectory(
        root: String,
        provider: CatalogProvider,
        scope: CatalogScope,
        category: String,
        detailPrefix: String? = nil,
        origin: CatalogOrigin = .folder
    ) -> [SkillRecord] {
        guard fileManager.fileExists(atPath: root) else { return [] }
        guard let enumerator = fileManager.enumerator(atPath: root) else { return [] }

        var records: [SkillRecord] = []
        for case let relative as String in enumerator {
            guard relative.hasSuffix("/SKILL.md") || relative == "SKILL.md" else { continue }
            let path = root + "/" + relative
            let metadata = parseFrontMatter(at: path)
            let folderName = URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent
            records.append(
                SkillRecord(
                    id: "\(provider.rawValue):\(scope.rawValue):\(path)",
                    name: metadata["name"] ?? folderName,
                    provider: provider,
                    scope: scope,
                    origin: origin,
                    category: category,
                    sourcePath: path,
                    detailSummary: formatDetailSummary(
                        primary: metadata["description"] ?? folderName,
                        prefix: detailPrefix
                    )
                )
            )
        }
        return records
    }

    private func scanMarkdownDirectory(
        root: String,
        provider: CatalogProvider,
        scope: CatalogScope,
        category: String,
        detailPrefix: String? = nil,
        origin: CatalogOrigin = .folder
    ) -> [AutomationRecord] {
        guard fileManager.fileExists(atPath: root) else { return [] }
        guard let enumerator = fileManager.enumerator(atPath: root) else { return [] }

        var records: [AutomationRecord] = []
        for case let relative as String in enumerator {
            guard relative.hasSuffix(".md") else { continue }
            let path = root + "/" + relative
            let metadata = parseFrontMatter(at: path)
            let name = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
            records.append(
                AutomationRecord(
                    id: "\(provider.rawValue):\(scope.rawValue):\(path)",
                    name: name,
                    provider: provider,
                    scope: scope,
                    origin: origin,
                    category: category,
                    sourcePath: path,
                    detailSummary: formatDetailSummary(
                        primary: metadata["description"] ?? name,
                        prefix: detailPrefix
                    )
                )
            )
        }
        return records
    }

    private func parseCodexConfiguredSkills(at path: String, scope: CatalogScope) -> [SkillRecord] {
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }

        let entries = parseCodexSkillConfigEntries(from: content)
        let configDirectory = URL(fileURLWithPath: path).deletingLastPathComponent().path

        return entries.compactMap { entry in
            guard entry.enabled else { return nil }
            let resolvedPath = resolvePath(entry.path, relativeTo: configDirectory)
            let skillPath: String
            if resolvedPath.hasSuffix("/SKILL.md") {
                skillPath = resolvedPath
            } else {
                skillPath = resolvedPath + "/SKILL.md"
            }
            guard fileManager.fileExists(atPath: skillPath) else { return nil }

            let metadata = parseFrontMatter(at: skillPath)
            let folderName = URL(fileURLWithPath: skillPath).deletingLastPathComponent().lastPathComponent
            return SkillRecord(
                id: "codex:configured:\(scope.rawValue):\(skillPath)",
                name: metadata["name"] ?? folderName,
                provider: .codex,
                scope: scope,
                origin: .folder,
                category: "Skill",
                sourcePath: skillPath,
                detailSummary: formatDetailSummary(
                    primary: metadata["description"] ?? folderName,
                    prefix: "Configured in \(URL(fileURLWithPath: path).lastPathComponent)"
                )
            )
        }
    }

    private func claudePluginMCPServers(projectPath: String?) -> [MCPServerRecord] {
        claudePluginInstallations(projectPath: projectPath).flatMap { plugin -> [MCPServerRecord] in
            let path = plugin.installPath + "/.mcp.json"
            guard let root = parseJSONDictionary(at: path) else { return [] }
            let servers = (root["mcpServers"] as? [String: Any]) ?? root

            return servers.compactMap { name, value -> MCPServerRecord? in
                guard let config = value as? [String: Any] else { return nil }
                let configuration = configuration(from: config)
                return MCPServerRecord(
                    id: "claude:plugin:mcp:\(plugin.key):\(name)",
                    name: name,
                    provider: .claude,
                    scope: plugin.scope,
                    origin: .plugin,
                    sourcePath: path,
                    owningProjectPath: plugin.projectPath,
                    transportSummary: configuration.transportSummary,
                    detailSummary: formatDetailSummary(
                        primary: configuration.detailSummary.nonEmpty ?? name,
                        prefix: "Plugin \(plugin.displayName)"
                    ),
                    configuration: configuration
                )
            }
        }
    }

    private func claudePluginSkills(projectPath: String?) -> [SkillRecord] {
        claudePluginInstallations(projectPath: projectPath).flatMap { plugin -> [SkillRecord] in
            scanSkillDirectory(
                root: plugin.installPath + "/skills",
                provider: .claude,
                scope: plugin.scope,
                category: "Plugin Skill",
                detailPrefix: "Plugin \(plugin.displayName)",
                origin: .plugin
            )
        }
    }

    private func claudePluginAutomations(projectPath: String?) -> [AutomationRecord] {
        claudePluginInstallations(projectPath: projectPath).flatMap { plugin -> [AutomationRecord] in
            var records: [AutomationRecord] = []
            records += scanMarkdownDirectory(
                root: plugin.installPath + "/commands",
                provider: .claude,
                scope: plugin.scope,
                category: "Command",
                detailPrefix: "Plugin \(plugin.displayName)",
                origin: .plugin
            )
            records += scanMarkdownDirectory(
                root: plugin.installPath + "/agents",
                provider: .claude,
                scope: plugin.scope,
                category: "Agent",
                detailPrefix: "Plugin \(plugin.displayName)",
                origin: .plugin
            )
            records += parseClaudeHooks(
                at: plugin.installPath + "/hooks/hooks.json",
                provider: .claude,
                scope: plugin.scope,
                sourceLabel: "Plugin \(plugin.displayName)",
                origin: .plugin
            )
            return records
        }
    }

    private func parseClaudeHooks(
        at path: String,
        provider: CatalogProvider,
        scope: CatalogScope,
        sourceLabel: String,
        origin: CatalogOrigin = .config
    ) -> [AutomationRecord] {
        guard let root = parseJSONDictionary(at: path),
              let hooks = root["hooks"] as? [String: Any] else { return [] }

        let description = stringValue(in: root, keys: ["description"])
        var records: [AutomationRecord] = []

        for eventName in hooks.keys.sorted() {
            guard let entries = hooks[eventName] as? [Any] else { continue }
            for (index, rawEntry) in entries.enumerated() {
                guard let entry = rawEntry as? [String: Any] else { continue }
                let matcher = stringValue(in: entry, keys: ["matcher"])
                let displayName = [eventName, matcher].compactMap { $0?.nonEmpty }.joined(separator: " · ")
                let commandPreview = ((entry["hooks"] as? [Any]) ?? [])
                    .compactMap { $0 as? [String: Any] }
                    .compactMap { stringValue(in: $0, keys: ["command", "type"]) }
                    .first
                records.append(
                    AutomationRecord(
                        id: "\(provider.rawValue):\(scope.rawValue):hook:\(path):\(eventName):\(index)",
                        name: displayName.nonEmpty ?? eventName,
                        provider: provider,
                        scope: scope,
                        origin: origin,
                        category: "Hook",
                        sourcePath: path,
                        detailSummary: formatDetailSummary(
                            primary: description ?? commandPreview ?? eventName,
                            prefix: sourceLabel
                        )
                    )
                )
            }
        }

        return records
    }

    private func configuration(from config: [String: Any]) -> MCPConfiguration {
        MCPConfiguration(
            url: config["url"] as? String,
            command: config["command"] as? String,
            args: (config["args"] as? [Any])?.compactMap { "\($0)" } ?? [],
            env: config["env"] as? [String: String] ?? [:],
            cwd: stringValue(in: config, keys: ["cwd"]),
            enabled: boolValue(in: config, keys: ["enabled"]),
            required: boolValue(in: config, keys: ["required"]),
            enabledTools: stringArrayValue(in: config, keys: ["enabledTools", "enabled_tools"]),
            disabledTools: stringArrayValue(in: config, keys: ["disabledTools", "disabled_tools"]),
            envVars: stringArrayValue(in: config, keys: ["envVars", "env_vars"]),
            bearerTokenEnvVar: stringValue(in: config, keys: ["bearerTokenEnvVar", "bearer_token_env_var"]),
            httpHeaders: stringDictionaryValue(in: config, keys: ["httpHeaders", "http_headers"]),
            envHTTPHeaders: stringDictionaryValue(in: config, keys: ["envHttpHeaders", "env_http_headers"]),
            scopes: stringArrayValue(in: config, keys: ["scopes"]),
            oauthResource: stringValue(in: config, keys: ["oauthResource", "oauth_resource"]),
            startupTimeoutSec: numberValue(in: config, keys: ["startupTimeoutSec", "startup_timeout_sec"]),
            startupTimeoutMS: intValue(in: config, keys: ["startupTimeoutMs", "startup_timeout_ms"]),
            toolTimeoutSec: numberValue(in: config, keys: ["toolTimeoutSec", "tool_timeout_sec"]),
            rawJSONObject: config
        )
    }

    private func claudePluginInstallations(projectPath: String?) -> [ClaudePluginInstallation] {
        guard let root = parseJSONDictionary(at: homeDirectory + "/.claude/plugins/installed_plugins.json"),
              let plugins = root["plugins"] as? [String: Any] else { return [] }

        let enabledPlugins = (parseJSONDictionary(at: claudeSettingsPath)?["enabledPlugins"] as? [String: Bool]) ?? [:]
        let normalizedProjectPath = projectPath.map(standardizePath)
        var installations: [ClaudePluginInstallation] = []

        for (key, rawValue) in plugins {
            guard let entries = rawValue as? [Any] else { continue }
            let selectedEntries = entries
                .compactMap { $0 as? [String: Any] }
                .filter { entry in
                    let scope = (entry["scope"] as? String) ?? "user"
                    switch scope {
                    case "user":
                        return true
                    case "project":
                        guard let normalizedProjectPath,
                              let candidate = entry["projectPath"] as? String else { return false }
                        return standardizePath(candidate) == normalizedProjectPath
                    default:
                        return false
                    }
                }
            guard let entry = latestClaudePluginEntry(from: selectedEntries) else { continue }
            guard enabledPlugins[key] ?? true else { continue }
            guard let installPath = entry["installPath"] as? String, !installPath.isEmpty else { continue }

            let manifest = parseJSONDictionary(at: installPath + "/.claude-plugin/plugin.json")
            let displayName = stringValue(in: manifest ?? [:], keys: ["name"]) ?? pluginName(from: key)
            let marketplace = pluginMarketplace(from: key)
            let scope = ((entry["scope"] as? String) == "project") ? CatalogScope.project : .user
            let project = entry["projectPath"] as? String

            installations.append(
                ClaudePluginInstallation(
                    key: key,
                    displayName: displayName,
                    marketplace: marketplace,
                    scope: scope,
                    projectPath: project,
                    installPath: installPath,
                    description: stringValue(in: manifest ?? [:], keys: ["description"])
                )
            )
        }

        return installations.sorted { lhs, rhs in
            if lhs.scope != rhs.scope { return lhs.scope.rawValue < rhs.scope.rawValue }
            if lhs.marketplace != rhs.marketplace { return lhs.marketplace < rhs.marketplace }
            return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
        }
    }

    private func latestClaudePluginEntry(from entries: [[String: Any]]) -> [String: Any]? {
        entries.max { lhs, rhs in
            pluginTimestamp(in: lhs) < pluginTimestamp(in: rhs)
        }
    }

    private func pluginTimestamp(in entry: [String: Any]) -> Date {
        let formatter = ISO8601DateFormatter()
        let candidates = [entry["lastUpdated"] as? String, entry["installedAt"] as? String]
        for candidate in candidates.compactMap({ $0 }) {
            if let date = formatter.date(from: candidate) {
                return date
            }
        }
        return .distantPast
    }

    private func pluginName(from key: String) -> String {
        guard let separator = key.lastIndex(of: "@") else { return key }
        return String(key[..<separator])
    }

    private func pluginMarketplace(from key: String) -> String {
        guard let separator = key.lastIndex(of: "@") else { return "plugin" }
        return String(key[key.index(after: separator)...])
    }

    private func codexProjectIsTrusted(_ projectPath: String) -> Bool {
        guard let content = try? String(contentsOfFile: codexConfigPath, encoding: .utf8) else { return false }
        let targetPath = standardizePath(projectPath)
        var currentProjectPath: String?

        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }

            if line.hasPrefix("[projects.\""), line.hasSuffix("\"]") {
                let start = line.index(line.startIndex, offsetBy: "[projects.\"".count)
                let end = line.index(line.endIndex, offsetBy: -2)
                currentProjectPath = standardizePath(unescapeTOMLStringLiteral(String(line[start..<end])))
                continue
            }

            if line.hasPrefix("[") {
                currentProjectPath = nil
                continue
            }

            guard currentProjectPath == targetPath else { continue }
            let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            if parts[0].trimmingCharacters(in: .whitespaces) == "trust_level" {
                return parseTOMLString(parts[1]) == "trusted"
            }
        }

        return false
    }

    private func isInstalled(_ client: ProviderClient) -> Bool {
        switch client {
        case .codex:
            return fileManager.fileExists(atPath: homeDirectory + "/.codex")
        case .claude:
            return fileManager.fileExists(atPath: homeDirectory + "/.claude")
                || fileManager.fileExists(atPath: claudeStatePath)
        case .cline:
            return fileManager.fileExists(atPath: homeDirectory + "/.cline")
        case .opencode:
            return fileManager.fileExists(atPath: homeDirectory + "/.opencode")
                || fileManager.fileExists(atPath: homeDirectory + "/.config/opencode")
        case .zai:
            return fileManager.fileExists(atPath: homeDirectory + "/.zai")
                || fileManager.fileExists(atPath: homeDirectory + "/.config/zai")
        }
    }

    private func upsertCodexServer(named name: String, configuration: MCPConfiguration, at path: String) -> Bool {
        let replacement = codexSectionLines(name: name, configuration: configuration)
        return rewriteCodexSection(at: path, name: name, replacement: replacement)
    }

    private func removeCodexServer(named name: String, at path: String) -> Bool {
        rewriteCodexSection(at: path, name: name, replacement: nil)
    }

    private func rewriteCodexSection(at path: String, name: String, replacement: [String]?) -> Bool {
        let original = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        let lines = original.components(separatedBy: .newlines)
        var output: [String] = []
        var index = 0
        var found = false

        while index < lines.count {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed == "[mcp_servers.\(name)]" {
                found = true
                if let replacement {
                    if !output.isEmpty, output.last?.isEmpty == false {
                        output.append("")
                    }
                    output.append(contentsOf: replacement)
                }
                index += 1
                while index < lines.count {
                    let nextTrimmed = lines[index].trimmingCharacters(in: .whitespaces)
                    if nextTrimmed.hasPrefix("[") && !nextTrimmed.hasPrefix("[mcp_servers.\(name)]") {
                        break
                    }
                    index += 1
                }
                continue
            }

            output.append(lines[index])
            index += 1
        }

        if !found, let replacement {
            if !output.isEmpty, output.last?.isEmpty == false {
                output.append("")
            }
            output.append(contentsOf: replacement)
        }

        let final = output.joined(separator: "\n").trimmingCharacters(in: .newlines) + "\n"
        return writeText(final, to: path)
    }

    private func codexSectionLines(name: String, configuration: MCPConfiguration) -> [String] {
        var lines = ["[mcp_servers.\(name)]"]
        if let url = configuration.url, !url.isEmpty {
            lines.append("url = \(tomlString(url))")
        }
        if let command = configuration.command, !command.isEmpty {
            lines.append("command = \(tomlString(command))")
        }
        if !configuration.args.isEmpty {
            let args = configuration.args.map(tomlString).joined(separator: ", ")
            lines.append("args = [\(args)]")
        }
        if !configuration.env.isEmpty {
            let env = configuration.env
                .sorted { $0.key < $1.key }
                .map { "\($0.key) = \(tomlString($0.value))" }
                .joined(separator: ", ")
            lines.append("env = { \(env) }")
        }
        if let cwd = configuration.cwd, !cwd.isEmpty {
            lines.append("cwd = \(tomlString(cwd))")
        }
        if let enabled = configuration.enabled {
            lines.append("enabled = \(enabled ? "true" : "false")")
        }
        if let required = configuration.required {
            lines.append("required = \(required ? "true" : "false")")
        }
        if !configuration.enabledTools.isEmpty {
            let enabledTools = configuration.enabledTools.map(tomlString).joined(separator: ", ")
            lines.append("enabled_tools = [\(enabledTools)]")
        }
        if !configuration.disabledTools.isEmpty {
            let disabledTools = configuration.disabledTools.map(tomlString).joined(separator: ", ")
            lines.append("disabled_tools = [\(disabledTools)]")
        }
        if !configuration.envVars.isEmpty {
            let envVars = configuration.envVars.map(tomlString).joined(separator: ", ")
            lines.append("env_vars = [\(envVars)]")
        }
        if let bearerTokenEnvVar = configuration.bearerTokenEnvVar, !bearerTokenEnvVar.isEmpty {
            lines.append("bearer_token_env_var = \(tomlString(bearerTokenEnvVar))")
        }
        if !configuration.httpHeaders.isEmpty {
            let headers = configuration.httpHeaders
                .sorted { $0.key < $1.key }
                .map { "\($0.key) = \(tomlString($0.value))" }
                .joined(separator: ", ")
            lines.append("http_headers = { \(headers) }")
        }
        if !configuration.envHTTPHeaders.isEmpty {
            let headers = configuration.envHTTPHeaders
                .sorted { $0.key < $1.key }
                .map { "\($0.key) = \(tomlString($0.value))" }
                .joined(separator: ", ")
            lines.append("env_http_headers = { \(headers) }")
        }
        if !configuration.scopes.isEmpty {
            let scopes = configuration.scopes.map(tomlString).joined(separator: ", ")
            lines.append("scopes = [\(scopes)]")
        }
        if let oauthResource = configuration.oauthResource, !oauthResource.isEmpty {
            lines.append("oauth_resource = \(tomlString(oauthResource))")
        }
        if let startupTimeoutSec = configuration.startupTimeoutSec {
            lines.append("startup_timeout_sec = \(tomlNumber(startupTimeoutSec))")
        }
        if let startupTimeoutMS = configuration.startupTimeoutMS {
            lines.append("startup_timeout_ms = \(startupTimeoutMS)")
        }
        if let toolTimeoutSec = configuration.toolTimeoutSec {
            lines.append("tool_timeout_sec = \(tomlNumber(toolTimeoutSec))")
        }
        return lines
    }

    private func upsertJSONServer(at path: String, keyPath: [String], name: String, configuration: MCPConfiguration) -> Bool {
        var root = parseJSONDictionary(at: path) ?? [:]
        setNestedDictionaryValue(&root, keyPath: keyPath + [name], value: configuration.jsonObject)
        return writeJSONObject(root, to: path)
    }

    private func removeJSONServer(at path: String, keyPath: [String], name: String) -> Bool {
        guard var root = parseJSONDictionary(at: path) else { return false }
        removeNestedDictionaryValue(&root, keyPath: keyPath + [name])
        return writeJSONObject(root, to: path)
    }

    private func removeProjectMCPServer(named name: String, at path: String) -> Bool {
        guard var root = parseJSONDictionary(at: path) else { return false }
        if root["mcpServers"] is [String: Any] {
            removeNestedDictionaryValue(&root, keyPath: ["mcpServers", name])
        } else {
            root.removeValue(forKey: name)
        }
        return writeJSONObject(root, to: path)
    }

    private func upsertProjectServer(named name: String, configuration: MCPConfiguration, at path: String) -> Bool {
        var root = parseJSONDictionary(at: path) ?? [:]
        if root["mcpServers"] is [String: Any] || root.isEmpty {
            setNestedDictionaryValue(&root, keyPath: ["mcpServers", name], value: configuration.jsonObject)
        } else {
            root[name] = configuration.jsonObject
        }
        return writeJSONObject(root, to: path)
    }

    private func writeJSONObject(_ object: [String: Any], to path: String) -> Bool {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: data, encoding: .utf8) else { return false }
        return writeText(string + "\n", to: path)
    }

    private func writeText(_ text: String, to path: String) -> Bool {
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
        try? fileManager.createDirectory(atPath: directory, withIntermediateDirectories: true)
        do {
            try text.write(toFile: path, atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    private func parseCodexSections(from content: String) -> [CodexMCPSection] {
        var sections: [CodexMCPSection] = []
        var currentName: String?
        var values: [String: String] = [:]

        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }

            if line.hasPrefix("[mcp_servers."), line.hasSuffix("]") {
                if let currentName {
                    sections.append(CodexMCPSection(name: currentName, configuration: configuration(from: values)))
                }
                currentName = line
                    .replacingOccurrences(of: "[mcp_servers.", with: "")
                    .replacingOccurrences(of: "]", with: "")
                values = [:]
                continue
            }

            guard let currentName, line.hasPrefix("[") == false else { continue }
            let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            values[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
            _ = currentName
        }

        if let currentName {
            sections.append(CodexMCPSection(name: currentName, configuration: configuration(from: values)))
        }

        return sections
    }

    private func configuration(from values: [String: String]) -> MCPConfiguration {
        MCPConfiguration(
            url: parseTOMLString(values["url"]),
            command: parseTOMLString(values["command"]),
            args: parseTOMLArray(values["args"]),
            env: parseTOMLMap(values["env"]),
            cwd: parseTOMLString(values["cwd"]),
            enabled: parseTOMLBool(values["enabled"]),
            required: parseTOMLBool(values["required"]),
            enabledTools: parseTOMLArray(values["enabled_tools"]),
            disabledTools: parseTOMLArray(values["disabled_tools"]),
            envVars: parseTOMLArray(values["env_vars"]),
            bearerTokenEnvVar: parseTOMLString(values["bearer_token_env_var"]),
            httpHeaders: parseTOMLMap(values["http_headers"]),
            envHTTPHeaders: parseTOMLMap(values["env_http_headers"]),
            scopes: parseTOMLArray(values["scopes"]),
            oauthResource: parseTOMLString(values["oauth_resource"]),
            startupTimeoutSec: parseTOMLNumber(values["startup_timeout_sec"]),
            startupTimeoutMS: parseTOMLInt(values["startup_timeout_ms"]),
            toolTimeoutSec: parseTOMLNumber(values["tool_timeout_sec"])
        )
    }

    private func parseTOMLString(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("\""), trimmed.hasSuffix("\"") {
            return unescapeTOMLStringLiteral(String(trimmed.dropFirst().dropLast()))
        }
        return trimmed.nonEmpty
    }

    private func unescapeTOMLStringLiteral(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }

    private func parseTOMLArray(_ raw: String?) -> [String] {
        guard let raw else { return [] }
        return matches(in: raw, pattern: "\"([^\"]+)\"")
    }

    private func parseTOMLBool(_ raw: String?) -> Bool? {
        guard let raw else { return nil }
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "true":
            return true
        case "false":
            return false
        default:
            return nil
        }
    }

    private func parseTOMLNumber(_ raw: String?) -> Double? {
        guard let raw else { return nil }
        return Double(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func parseTOMLInt(_ raw: String?) -> Int? {
        guard let raw else { return nil }
        return Int(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func parseTOMLMap(_ raw: String?) -> [String: String] {
        guard let raw else { return [:] }
        let matches = matchesWithGroups(in: raw, pattern: "([A-Za-z0-9_]+)\\s*=\\s*\"([^\"]*)\"")
        return Dictionary(uniqueKeysWithValues: matches.compactMap { groups in
            guard groups.count >= 3 else { return nil }
            return (groups[1], groups[2])
        })
    }

    private func tomlString(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\"", with: "\\\""))\""
    }

    private func tomlNumber(_ value: Double) -> String {
        if value.rounded(.towardZero) == value {
            return String(Int(value))
        }
        return String(value)
    }

    private func parseCodexSkillConfigEntries(from content: String) -> [(path: String, enabled: Bool)] {
        var entries: [(path: String, enabled: Bool)] = []
        var current: [String: String]? = nil

        for rawLine in content.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") { continue }

            if line == "[[skills.config]]" {
                if let current,
                   let path = parseTOMLString(current["path"]) {
                    entries.append((path: path, enabled: parseTOMLBool(current["enabled"]) ?? true))
                }
                current = [:]
                continue
            }

            if line.hasPrefix("[[") || line.hasPrefix("[") {
                if let current,
                   let path = parseTOMLString(current["path"]) {
                    entries.append((path: path, enabled: parseTOMLBool(current["enabled"]) ?? true))
                }
                current = nil
                continue
            }

            guard current != nil else { continue }
            let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            current?[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
        }

        if let current,
           let path = parseTOMLString(current["path"]) {
            entries.append((path: path, enabled: parseTOMLBool(current["enabled"]) ?? true))
        }

        return entries
    }

    private func resolvePath(_ path: String, relativeTo baseDirectory: String) -> String {
        if path.hasPrefix("/") {
            return standardizePath(path)
        }
        return URL(fileURLWithPath: baseDirectory)
            .appendingPathComponent(path)
            .standardizedFileURL
            .path
    }

    private func standardizePath(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.path
    }

    private func formatDetailSummary(primary: String, prefix: String?) -> String {
        guard let prefix, !prefix.isEmpty else { return primary }
        return "\(prefix) · \(primary)"
    }

    private func stringValue(in config: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = config[key] as? String, !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private func boolValue(in config: [String: Any], keys: [String]) -> Bool? {
        for key in keys {
            if let value = config[key] as? Bool {
                return value
            }
        }
        return nil
    }

    private func intValue(in config: [String: Any], keys: [String]) -> Int? {
        for key in keys {
            if let value = config[key] as? Int {
                return value
            }
            if let value = config[key] as? Double {
                return Int(value)
            }
        }
        return nil
    }

    private func numberValue(in config: [String: Any], keys: [String]) -> Double? {
        for key in keys {
            if let value = config[key] as? Double {
                return value
            }
            if let value = config[key] as? Int {
                return Double(value)
            }
        }
        return nil
    }

    private func stringArrayValue(in config: [String: Any], keys: [String]) -> [String] {
        for key in keys {
            if let values = config[key] as? [String] {
                return values
            }
            if let values = config[key] as? [Any] {
                return values.compactMap { "\($0)" }
            }
        }
        return []
    }

    private func stringDictionaryValue(in config: [String: Any], keys: [String]) -> [String: String] {
        for key in keys {
            if let value = config[key] as? [String: String] {
                return value
            }
            if let value = config[key] as? [String: Any] {
                return value.compactMapValues { entry in
                    if let string = entry as? String {
                        return string
                    }
                    return nil
                }
            }
        }
        return [:]
    }

    private func matches(in text: String, pattern: String) -> [String] {
        matchesWithGroups(in: text, pattern: pattern).compactMap { groups in
            groups.count > 1 ? groups[1] : nil
        }
    }

    private func matchesWithGroups(in text: String, pattern: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            (0..<match.numberOfRanges).compactMap { index in
                guard let range = Range(match.range(at: index), in: text) else { return nil }
                return String(text[range])
            }
        }
    }

    private func parseFrontMatter(at path: String) -> [String: String] {
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return [:] }
        let lines = content.components(separatedBy: .newlines)
        guard lines.first == "---" else { return [:] }

        var metadata: [String: String] = [:]
        for line in lines.dropFirst() {
            if line == "---" { break }
            let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            metadata[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
        }
        return metadata
    }

    private func parseJSONDictionary(at path: String) -> [String: Any]? {
        guard let data = fileManager.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else { return nil }
        return dictionary
    }

    private func nestedDictionary(_ root: [String: Any], keyPath: [String]) -> [String: Any]? {
        var current: Any = root
        for key in keyPath {
            guard let next = (current as? [String: Any])?[key] else { return nil }
            current = next
        }
        return current as? [String: Any]
    }

    private func setNestedDictionaryValue(_ root: inout [String: Any], keyPath: [String], value: Any) {
        guard let first = keyPath.first else { return }
        if keyPath.count == 1 {
            root[first] = value
            return
        }

        var child = root[first] as? [String: Any] ?? [:]
        setNestedDictionaryValue(&child, keyPath: Array(keyPath.dropFirst()), value: value)
        root[first] = child
    }

    private func removeNestedDictionaryValue(_ root: inout [String: Any], keyPath: [String]) {
        guard let first = keyPath.first else { return }
        if keyPath.count == 1 {
            root.removeValue(forKey: first)
            return
        }

        guard var child = root[first] as? [String: Any] else { return }
        removeNestedDictionaryValue(&child, keyPath: Array(keyPath.dropFirst()))
        root[first] = child
    }
}

private extension String {
    var nonEmpty: String? {
        trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
