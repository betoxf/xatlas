import Foundation

struct MCPDraft: Equatable {
    var name: String
    var url: String
    var command: String
    var args: [String]
    var env: [String: String]

    var configuration: MCPConfiguration {
        MCPConfiguration(
            url: Self.trimmedOrNil(url),
            command: Self.trimmedOrNil(command),
            args: args,
            env: env
        )
    }

    private static func trimmedOrNil(_ value: String) -> String? {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }
}

final class MCPAuthoringService {
    nonisolated(unsafe) static let shared = MCPAuthoringService()

    func generateDraft(from request: String, provider: AISyncProvider? = nil, projectPath: String? = nil) -> MCPDraft? {
        let prompt = buildPrompt(for: request, projectPath: projectPath)
        let output = run(provider: provider ?? preferredProvider(), prompt: prompt, workingDirectory: projectPath ?? NSHomeDirectory())
        guard let json = extractJSONObject(from: output),
              let object = parseJSONObject(json),
              let name = object["name"] as? String else {
            return nil
        }

        let env = object["env"] as? [String: String] ?? [:]
        let args = (object["args"] as? [Any])?.compactMap { "\($0)" } ?? []
        return MCPDraft(
            name: name,
            url: object["url"] as? String ?? "",
            command: object["command"] as? String ?? "",
            args: args,
            env: env
        )
    }

    private func buildPrompt(for request: String, projectPath: String?) -> String {
        let context = projectPath?.isEmpty == false ? "Project path: \(projectPath!)" : "No project path provided."
        return """
        Convert the user's request into a single MCP server configuration for macOS AI clients.
        Return JSON only with this exact shape:
        {"name":"server-name","url":"","command":"","args":[],"env":{}}

        Rules:
        - Use either url or command. Never require both unless the request explicitly needs both.
        - For HTTP/streamable MCP servers, fill url and leave command empty.
        - For stdio MCP servers, fill command and args and leave url empty.
        - Keep env to only variables explicitly implied by the request.
        - Name must be short, lowercase, kebab-case, and stable.
        - If the request is ambiguous, choose the most practical local setup instead of asking a question.
        - Return only JSON. No markdown. No explanation.

        \(context)
        User request: \(request)
        """
    }

    private func preferredProvider() -> AISyncProvider {
        let preferences = AppPreferences.shared.syncProvider
        if preferences != .builtIn {
            return preferences
        }

        let availability = AgentCatalogService.shared.providerAvailability()
        if availability.contains(where: { $0.client == .codex && $0.isInstalled }) {
            return .codex
        }
        if availability.contains(where: { $0.client == .claude && $0.isInstalled }) {
            return .claude
        }
        if availability.contains(where: { $0.client == .zai && $0.isInstalled }) {
            return .zai
        }
        return .codex
    }

    private func run(provider: AISyncProvider, prompt: String, workingDirectory: String) -> String {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()

        process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = arguments(for: provider, prompt: prompt)
        process.standardOutput = stdout
        process.standardError = stderr

        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return "" }
            let data = stdout.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }

    private func arguments(for provider: AISyncProvider, prompt: String) -> [String] {
        switch provider {
        case .builtIn:
            return ["printf", ""]
        case .codex:
            return [
                "codex", "exec",
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                prompt
            ]
        case .claude:
            return [
                "claude",
                "-p",
                "--dangerously-skip-permissions",
                prompt
            ]
        case .zai:
            return [
                "zai",
                "-p",
                "--dangerously-skip-permissions",
                prompt
            ]
        }
    }

    private func extractJSONObject(from raw: String) -> String? {
        guard let start = raw.firstIndex(of: "{"),
              let end = raw.lastIndex(of: "}") else { return nil }
        return String(raw[start...end])
    }

    private func parseJSONObject(_ raw: String) -> [String: Any]? {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object
    }
}
