import Foundation

struct ProjectOperatorReport: Decodable {
    let overview: String
    let lastWorkedOn: String
    let recentCommits: [String]
    let nextSuggestedAction: String
    let questionForHuman: String?
    let canContinueAutonomously: Bool
    let currentGoal: String?

    private enum CodingKeys: String, CodingKey {
        case overview
        case lastWorkedOn = "last_worked_on"
        case recentCommits = "recent_commits"
        case nextSuggestedAction = "next_suggested_action"
        case questionForHuman = "question_for_human"
        case canContinueAutonomously = "can_continue_autonomously"
        case currentGoal = "current_goal"
    }
}

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

    func projectOperatorReport(
        for path: String,
        projectName: String,
        autonomy: OperatorAutonomyLevel,
        provider: AISyncProvider? = nil
    ) -> ProjectOperatorReport? {
        let selectedProvider = interactiveProvider(preferred: provider ?? AppPreferences.shared.syncProvider)
        let prompt = """
        You are the xatlas operator intake agent for the repository "\(projectName)".
        Inspect the repository root, the most relevant manifests/readme files, current git status, and the latest 6 commits.
        Infer what the project is about, what was worked on most recently, and what the next sensible step is.
        Respect this autonomy level: \(autonomy.title) - \(autonomy.summary)

        Return strict JSON only, with no markdown fences and no extra commentary:
        {
          "overview": "one concise paragraph",
          "last_worked_on": "one concise sentence about the latest meaningful work",
          "recent_commits": ["short commit summary", "short commit summary"],
          "next_suggested_action": "one concrete next step",
          "question_for_human": "only if a human decision is required, else null",
          "can_continue_autonomously": true,
          "current_goal": "what the operator should optimize for next"
        }
        """

        let output = run(provider: selectedProvider, prompt: prompt, workingDirectory: path)
        if let json = extractJSONObject(from: output),
           let data = json.data(using: .utf8),
           let report = try? JSONDecoder().decode(ProjectOperatorReport.self, from: data) {
            return report
        }

        let recentCommits = GitService.shared.recentCommitSummaries(at: path, limit: 5)
        let latestCommit = recentCommits.first ?? "No recent commits detected."
        let status = GitService.shared.status(at: path)
        let nextStep: String
        if status.isRepo, !status.changes.isEmpty {
            nextStep = "Review the current uncommitted changes, validate them, and decide whether to keep iterating or commit."
        } else {
            nextStep = "Inspect the main entry points and choose the next milestone before starting another agent run."
        }

        return ProjectOperatorReport(
            overview: "\(projectName) lives at \(path.replacingOccurrences(of: NSHomeDirectory(), with: "~")).",
            lastWorkedOn: latestCommit,
            recentCommits: recentCommits,
            nextSuggestedAction: nextStep,
            questionForHuman: autonomy == .askHuman ? "What should the operator prioritize next in \(projectName)?" : nil,
            canContinueAutonomously: autonomy != .askHuman,
            currentGoal: recentCommits.first
        )
    }

    func projectOperatorPrompt(for project: Project, state: ProjectOperatorState) -> String {
        let commits = state.recentCommits.isEmpty ? "- No recent commits captured yet." : state.recentCommits.map { "- \($0)" }.joined(separator: "\n")
        let questionLine = state.questionForHuman ?? "Only escalate if the next step requires a product or priority decision."
        let resultSummary = state.lastResultSummary ?? "No previous managed run summary."

        return """
        You are the xatlas operator responsible for the project "\(project.name)".
        Repository path: \(project.path)
        Project overview: \(state.overview.nonEmpty ?? "Unknown. Inspect the repository before acting.")
        Latest known work: \(state.lastWorkedOn.nonEmpty ?? "Unknown.")
        Current goal: \(state.currentGoal?.nonEmpty ?? state.nextSuggestedAction.nonEmpty ?? "Figure out the next concrete milestone from the codebase state.")
        Suggested next action: \(state.nextSuggestedAction.nonEmpty ?? "Inspect the repo and choose the next logical task.")
        Recent commits:
        \(commits)

        Autonomy level: \(state.autonomy.title)
        Policy:
        - Ask First: pause on meaningful implementation choices and request confirmation.
        - Balanced: proceed on clear, low-risk next steps; escalate product or architecture choices.
        - Drive: keep executing concrete next steps until blocked, then escalate only major decisions.

        Operating rules:
        - Start by checking git status and any uncommitted work before editing.
        - Prefer continuing from the repository's current state instead of starting over.
        - Make concrete progress, run validation when appropriate, and summarize what changed.
        - If you need the human, end with exactly one line starting with NEEDS_CONFIRMATION: followed by the question.
        - Otherwise end with a short status update and the next action.

        Last managed result:
        \(resultSummary)

        Human escalation rule:
        \(questionLine)
        """
    }

    func projectOperatorCommand(
        for project: Project,
        state: ProjectOperatorState,
        userInstruction: String? = nil,
        provider: AISyncProvider? = nil
    ) -> String {
        let selectedProvider = interactiveProvider(preferred: provider ?? AppPreferences.shared.syncProvider)
        var prompt = projectOperatorPrompt(for: project, state: state)
        if let userInstruction = userInstruction?.trimmingCharacters(in: .whitespacesAndNewlines),
           !userInstruction.isEmpty {
            prompt += "\n\nNew operator instruction from the human:\n\(userInstruction)"
        }
        return shellCommand(for: selectedProvider, prompt: prompt)
    }

    func projectOperatorContinueCommand(
        for project: Project,
        state: ProjectOperatorState,
        snapshot: String,
        provider: AISyncProvider? = nil
    ) -> String {
        let selectedProvider = interactiveProvider(preferred: provider ?? AppPreferences.shared.syncProvider)
        let prompt = """
        Continue as the xatlas operator for "\(project.name)".
        Keep the same autonomy rules as before: \(state.autonomy.title) - \(state.autonomy.summary)
        Current repository overview: \(state.overview.nonEmpty ?? "Unknown")
        Latest known work: \(state.lastWorkedOn.nonEmpty ?? "Unknown")
        Suggested next action: \(state.nextSuggestedAction.nonEmpty ?? "Inspect the repository and choose the next step.")

        Most recent terminal output:
        \(snapshot)

        Continue with the next concrete step from the repository's current state.
        If you need a human decision, end with exactly one line starting with NEEDS_CONFIRMATION: followed by the question.
        Otherwise keep moving and end with a short status update plus the next action.
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

    private func extractJSONObject(from raw: String) -> String? {
        guard let start = raw.firstIndex(of: "{"),
              let end = raw.lastIndex(of: "}") else {
            return nil
        }
        let json = String(raw[start...end])
        return json.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : json
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
