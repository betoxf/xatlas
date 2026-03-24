import Foundation

final class AISyncService {
    nonisolated(unsafe) static let shared = AISyncService()

    func commitMessage(for path: String, status: GitStatus) -> String {
        let fallback = GitService.shared.generateCommitMessage(for: status)
        let preferences = AppPreferences.shared

        guard preferences.useAIForSync else { return fallback }
        let summary = GitService.shared.diffSummary(at: path)
        guard !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return fallback }

        let prompt = """
        Write one concise git commit message in imperative mood.
        Return only the commit message, no quotes, no bullets, no explanation.

        Repository status and diff summary:
        \(summary)
        """

        let output = run(provider: preferences.syncProvider, prompt: prompt, workingDirectory: path)
        let cleaned = sanitize(output)
        return cleaned.isEmpty ? fallback : cleaned
    }

    func projectBriefCommand(for path: String, provider: AISyncProvider? = nil) -> String {
        let selectedProvider = interactiveProvider(preferred: provider ?? AppPreferences.shared.syncProvider)
        let prompt = """
        Look at the latest git commit in this repository and the repository root.
        Reply with exactly two short sentences.
        Sentence 1: what this project is.
        Sentence 2: what the latest commit changed.
        Be concrete and brief.
        """
        return shellCommand(for: selectedProvider, prompt: prompt)
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

    private func shellCommand(for provider: AISyncProvider, prompt: String) -> String {
        let args = arguments(for: provider, prompt: prompt)
        return args.map(Self.shellEscape).joined(separator: " ")
    }

    private func interactiveProvider(preferred: AISyncProvider) -> AISyncProvider {
        if preferred != .builtIn {
            return preferred
        }

        let available = AgentCatalogService.shared.providerAvailability()
        if available.contains(where: { $0.client == .codex && $0.isInstalled }) {
            return .codex
        }
        if available.contains(where: { $0.client == .claude && $0.isInstalled }) {
            return .claude
        }
        if available.contains(where: { $0.client == .zai && $0.isInstalled }) {
            return .zai
        }
        return .codex
    }

    private static func shellEscape(_ value: String) -> String {
        if value.isEmpty { return "''" }
        let escaped = value.replacingOccurrences(of: "'", with: "'\"'\"'")
        return "'\(escaped)'"
    }

    private func sanitize(_ raw: String) -> String {
        raw
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty && !$0.hasPrefix("OpenAI Codex") && !$0.hasPrefix("workdir:") && !$0.hasPrefix("model:") && !$0.hasPrefix("provider:") && !$0.hasPrefix("approval:") && !$0.hasPrefix("sandbox:") && !$0.hasPrefix("reasoning") && !$0.hasPrefix("session id:") && $0 != "--------" && $0 != "user" && $0 != "codex" && !$0.hasPrefix("tokens used") })?
            .replacingOccurrences(of: "\"", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
    }
}
