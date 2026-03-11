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

struct MCPConfiguration: Equatable {
    let url: String?
    let command: String?
    let args: [String]
    let env: [String: String]

    var transportSummary: String {
        url != nil ? "HTTP" : "stdio"
    }

    var detailSummary: String {
        if let url, !url.isEmpty {
            return url
        }

        let pieces = [command] + args
        return pieces.compactMap { $0 }.joined(separator: " ")
    }

    var jsonObject: [String: Any] {
        var object: [String: Any] = [:]
        if let url, !url.isEmpty {
            object["url"] = url
        }
        if let command, !command.isEmpty {
            object["command"] = command
        }
        if !args.isEmpty {
            object["args"] = args
        }
        if !env.isEmpty {
            object["env"] = env
        }
        return object
    }
}

struct MCPServerRecord: Identifiable {
    let id: String
    let name: String
    let provider: CatalogProvider
    let scope: CatalogScope
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
    let sourcePath: String
    let detailSummary: String
}

struct AutomationRecord: Identifiable {
    let id: String
    let name: String
    let provider: CatalogProvider
    let scope: CatalogScope
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

        records += parseCodexMCPConfig(at: codexConfigPath)
        records += parseClaudeMCPJSON(at: claudeSettingsPath, keyPath: ["mcpServers"], provider: .claude, scope: .user)
        records += parseClaudeMCPJSON(at: claudeStatePath, keyPath: ["mcpServers"], provider: .claude, scope: .local)

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
        records += scanSkillDirectory(root: homeDirectory + "/.codex/skills", provider: .codex, scope: .user)
        records += scanSkillDirectory(root: homeDirectory + "/.claude/skills", provider: .claude, scope: .user)
        if let projectPath {
            records += scanSkillDirectory(root: projectPath + "/.claude/skills", provider: .project, scope: .project)
        }
        return records.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func automations(projectPath: String?) -> [AutomationRecord] {
        var records: [AutomationRecord] = []
        records += scanMarkdownDirectory(root: homeDirectory + "/.claude/commands", provider: .claude, scope: .user)
        if let projectPath {
            records += scanMarkdownDirectory(root: projectPath + "/.claude/commands", provider: .project, scope: .project)
        }
        return records.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func parseCodexMCPConfig(at path: String) -> [MCPServerRecord] {
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
        let sections = parseCodexSections(from: content)

        return sections.map { section in
            MCPServerRecord(
                id: "codex:\(section.name):\(path)",
                name: section.name,
                provider: .codex,
                scope: .user,
                sourcePath: path,
                owningProjectPath: nil,
                transportSummary: section.configuration.transportSummary,
                detailSummary: section.configuration.detailSummary.nonEmpty ?? "Configured in ~/.codex/config.toml",
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
                sourcePath: path,
                owningProjectPath: projectPath,
                transportSummary: configuration.transportSummary,
                detailSummary: configuration.detailSummary.nonEmpty ?? "Configured in .mcp.json",
                configuration: configuration
            )
        }
    }

    private func scanSkillDirectory(root: String, provider: CatalogProvider, scope: CatalogScope) -> [SkillRecord] {
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
                    sourcePath: path,
                    detailSummary: metadata["description"] ?? path
                )
            )
        }
        return records
    }

    private func scanMarkdownDirectory(root: String, provider: CatalogProvider, scope: CatalogScope) -> [AutomationRecord] {
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
                    sourcePath: path,
                    detailSummary: metadata["description"] ?? path
                )
            )
        }
        return records
    }

    private func configuration(from config: [String: Any]) -> MCPConfiguration {
        MCPConfiguration(
            url: config["url"] as? String,
            command: config["command"] as? String,
            args: (config["args"] as? [Any])?.compactMap { "\($0)" } ?? [],
            env: config["env"] as? [String: String] ?? [:]
        )
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
            env: parseTOMLMap(values["env"])
        )
    }

    private func parseTOMLString(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("\""), trimmed.hasSuffix("\"") {
            return String(trimmed.dropFirst().dropLast())
        }
        return trimmed.nonEmpty
    }

    private func parseTOMLArray(_ raw: String?) -> [String] {
        guard let raw else { return [] }
        return matches(in: raw, pattern: "\"([^\"]+)\"")
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
