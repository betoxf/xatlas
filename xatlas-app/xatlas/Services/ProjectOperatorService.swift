import Foundation
import SwiftUI

@Observable
final class ProjectOperatorService: @unchecked Sendable {
    static let shared = ProjectOperatorService()

    private(set) var states: [UUID: ProjectOperatorState]
    private(set) var consoleMessages: [OperatorConsoleMessage]
    private(set) var globalOperatorSessionID: String?
    private(set) var isGlobalOperatorReady = false

    private let store = ProjectOperatorStore.shared
    private let automaticContinuationLimit = 2
    private let maxConsoleMessages = 18
    private let globalOperatorTitle = "Operator"
    private var terminalObserver: NSObjectProtocol?
    private var lastGlobalReply: String?

    private init() {
        states = store.load()
        consoleMessages = []
        terminalObserver = NotificationCenter.default.addObserver(
            forName: .xatlasTerminalSessionDidChange,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self,
                  let session = note.userInfo?["session"] as? TerminalSession else { return }
            self.handleSessionUpdate(session)
        }
    }

    deinit {
        if let terminalObserver {
            NotificationCenter.default.removeObserver(terminalObserver)
        }
    }

    func bootstrap(projects: [Project]) {
        syncProjects(projects)
        for project in projects {
            let current = state(for: project.id)
            if current.lastScanAt == nil, current.status == .unscanned, current.autonomy != .drive {
                mutate(project.id) { state in
                    state.autonomy = .drive
                }
            }
        }
    }

    func syncProjects(_ projects: [Project]) {
        let projectIDs = Set(projects.map(\.id))
        states = states.filter { projectIDs.contains($0.key) }
        for project in projects where states[project.id] == nil {
            states[project.id] = ProjectOperatorState(projectID: project.id, autonomy: .drive)
        }
        persist()
    }

    func state(for projectID: UUID) -> ProjectOperatorState {
        if let state = states[projectID] {
            return state
        }
        let state = ProjectOperatorState(projectID: projectID, autonomy: .drive)
        states[projectID] = state
        persist()
        return state
    }

    func setAutonomy(_ autonomy: OperatorAutonomyLevel, for projectID: UUID) {
        mutate(projectID) { state in
            state.autonomy = autonomy
        }
    }

    func refreshAllProjects(_ projects: [Project]) {
        for project in projects {
            refreshProject(project)
        }
    }

    func refreshProject(_ project: Project, provider: AISyncProvider? = nil) {
        let autonomy = state(for: project.id).autonomy
        mutate(project.id) { state in
            state.status = .scanning
            state.lastError = nil
            state.questionForHuman = nil
        }

        Task.detached(priority: .utility) {
            let report = AISyncService.shared.projectOperatorReport(
                for: project.path,
                projectName: project.name,
                autonomy: autonomy,
                provider: provider
            )
            guard let report else {
                await MainActor.run {
                    self.mutate(project.id) { state in
                        state.status = .failed
                        state.lastError = "Operator scan failed."
                    }
                    self.appendMessage(
                        role: .assistant,
                        text: "I couldn't finish scanning \(project.name). Refresh the context and I'll try again.",
                        projectID: project.id
                    )
                }
                return
            }

            await MainActor.run {
                self.mutate(project.id) { state in
                    state.status = report.questionForHuman == nil ? .ready : .needsConfirmation
                    state.overview = report.overview
                    state.lastWorkedOn = report.lastWorkedOn
                    state.recentCommits = report.recentCommits
                    state.nextSuggestedAction = report.nextSuggestedAction
                    state.questionForHuman = report.questionForHuman
                    state.canContinueAutonomously = report.canContinueAutonomously
                    state.currentGoal = report.currentGoal
                    state.operatorPrompt = AISyncService.shared.projectOperatorPrompt(
                        for: project,
                        state: state
                    )
                    state.lastScanAt = .now
                    state.lastError = nil
                }
            }
        }
    }

    @discardableResult
    func startManagedAgent(
        for project: Project,
        userInstruction: String? = nil,
        provider: AISyncProvider? = nil
    ) -> String? {
        var current = state(for: project.id)
        if current.operatorPrompt.isEmpty {
            current.operatorPrompt = AISyncService.shared.projectOperatorPrompt(for: project, state: current)
        }

        let command = AISyncService.shared.projectOperatorCommand(
            for: project,
            state: current,
            userInstruction: userInstruction,
            provider: provider
        )
        guard !command.isEmpty else { return nil }

        let tab = AppState.shared.createTerminal(for: project)
        guard case .terminal(let sessionID) = tab.kind,
              TerminalService.shared.sendCommand(command, to: sessionID) else { return nil }

        let activityText: String
        if let userInstruction = userInstruction?.trimmingCharacters(in: .whitespacesAndNewlines),
           !userInstruction.isEmpty {
            activityText = "Running \(project.name) with your instruction: \(userInstruction)"
        } else {
            activityText = "Running the operator for \(project.name) using the latest project context."
        }
        appendMessage(role: .assistant, text: activityText, projectID: project.id)

        mutate(project.id) { state in
            state.managedSessionID = sessionID
            state.operatorPrompt = current.operatorPrompt
            state.status = .running
            state.questionForHuman = nil
            state.automaticContinuationCount = 0
            state.lastManagedRunAt = .now
            state.lastError = nil
        }

        return sessionID
    }

    @discardableResult
    func openManagedSession(for projectID: UUID) -> Bool {
        guard let sessionID = states[projectID]?.managedSessionID else { return false }
        return AppState.shared.openTerminalSession(sessionID)
    }

    @discardableResult
    func sendConsoleMessage(_ text: String, preferredProject: Project?) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        appendMessage(role: .user, text: trimmed)

        guard let sessionID = ensureGlobalOperatorSession() else {
            appendMessage(
                role: .assistant,
                text: "I couldn't start the background Codex operator."
            )
            return false
        }

        let sent = TerminalService.shared.sendCommand(trimmed, to: sessionID)
        if !sent {
            appendMessage(
                role: .assistant,
                text: "The background Codex operator didn't accept that message."
            )
        }
        return sent
    }

    @discardableResult
    func activateConsole() -> Bool {
        ensureGlobalOperatorSession() != nil
    }

    private func handleSessionUpdate(_ session: TerminalSession) {
        if session.id == globalOperatorSessionID {
            handleGlobalOperatorUpdate(session)
            return
        }

        guard let projectID = session.projectID,
              let state = states[projectID],
              state.managedSessionID == session.id else { return }

        if session.activityState == .running {
            mutate(projectID) { $0.status = .running }
            return
        }

        if session.activityState == .exited || session.activityState == .error {
            mutate(projectID) { state in
                state.managedSessionID = nil
                state.status = .failed
                state.lastError = session.activityState == .error
                    ? "Managed agent session failed."
                    : "Managed agent session exited."
            }
            return
        }

        guard session.requiresAttention, session.activityState == .idle else { return }
        let snapshot = TerminalService.shared.snapshot(for: session.id, lines: 80) ?? ""
        let question = Self.extractQuestion(from: snapshot)
        let summary = Self.extractResultSummary(from: snapshot)

        mutate(projectID) { state in
            state.lastResultSummary = summary
            state.lastManagedRunAt = .now
        }

        if let question {
            mutate(projectID) { state in
                state.status = .needsConfirmation
                state.questionForHuman = question
            }
            appendMessage(role: .assistant, text: question, projectID: projectID)
            AppState.shared.showToast(
                title: "Operator needs confirmation",
                message: AppState.shared.projects.first(where: { $0.id == projectID })?.name,
                style: .warning
            )
            return
        }

        let latestState = self.state(for: projectID)
        guard latestState.autonomy == .drive,
              latestState.automaticContinuationCount < automaticContinuationLimit,
              let project = AppState.shared.projects.first(where: { $0.id == projectID }) else {
            mutate(projectID) { state in
                state.status = .ready
                state.questionForHuman = nil
            }
            if let summary {
                appendMessage(role: .assistant, text: summary, projectID: projectID)
            }
            return
        }

        let command = AISyncService.shared.projectOperatorContinueCommand(
            for: project,
            state: latestState,
            snapshot: snapshot
        )
        guard !command.isEmpty,
              TerminalService.shared.sendCommand(command, to: session.id) else {
            mutate(projectID) { state in
                state.status = .ready
            }
            return
        }

        mutate(projectID) { state in
            state.status = .running
            state.questionForHuman = nil
            state.automaticContinuationCount += 1
        }
        if let summary {
            appendMessage(
                role: .assistant,
                text: "\(summary)\nContinuing automatically for \(project.name).",
                projectID: projectID
            )
        }
    }

    @discardableResult
    private func ensureGlobalOperatorSession() -> String? {
        if let globalOperatorSessionID,
           let session = TerminalService.shared.session(id: globalOperatorSessionID) {
            if session.activityState != .error && session.activityState != .exited {
                return globalOperatorSessionID
            }

            TerminalService.shared.removeSession(globalOperatorSessionID, killTmux: true)
            self.globalOperatorSessionID = nil
        }

        if let existing = TerminalService.shared.sessions.first(where: {
            $0.displayTitle == globalOperatorTitle &&
            (($0.currentDirectory ?? $0.workingDirectory) == NSHomeDirectory())
        }) {
            if existing.activityState == .error || existing.activityState == .exited {
                TerminalService.shared.removeSession(existing.id, killTmux: true)
            } else {
                TerminalService.shared.setPinnedTitle(globalOperatorTitle, for: existing.id)
                globalOperatorSessionID = existing.id
                isGlobalOperatorReady = existing.activityState != .error && existing.activityState != .exited
                return existing.id
            }
        }

        let session = TerminalService.shared.createSession(
            title: globalOperatorTitle,
            projectID: nil,
            workingDirectory: NSHomeDirectory()
        )
        TerminalService.shared.setPinnedTitle(globalOperatorTitle, for: session.id)
        globalOperatorSessionID = session.id

        guard TerminalService.shared.sendCommand(globalOperatorCommand(), to: session.id) else {
            isGlobalOperatorReady = false
            appendMessage(
                role: .assistant,
                text: "I couldn't start the Codex operator in the background."
            )
            return nil
        }

        isGlobalOperatorReady = true
        return session.id
    }

    private func globalOperatorCommand() -> String {
        let executable = globalOperatorExecutablePath()
        return "\(Self.shellEscape(executable)) --yolo"
    }

    private func globalOperatorExecutablePath() -> String {
        let fileManager = FileManager.default
        let bundledCodex = "/Applications/Codex.app/Contents/Resources/codex"
        if fileManager.isExecutableFile(atPath: bundledCodex) {
            return bundledCodex
        }
        return "codex"
    }

    private func handleGlobalOperatorUpdate(_ session: TerminalSession) {
        switch session.activityState {
        case .error, .exited:
            if session.id == globalOperatorSessionID {
                globalOperatorSessionID = nil
            }
            isGlobalOperatorReady = false
            appendMessage(
                role: .assistant,
                text: "The background Codex operator stopped. Send a message and I'll restart it."
            )
            return
        case .running, .idle, .detached:
            isGlobalOperatorReady = true
        }

        guard session.requiresAttention, session.activityState == .idle else { return }
        let snapshot = TerminalService.shared.snapshot(for: session.id, lines: 120) ?? ""
        guard let reply = Self.extractOperatorReply(from: snapshot),
              reply != lastGlobalReply else { return }
        lastGlobalReply = reply
        appendMessage(role: .assistant, text: reply)
    }

    private func mutate(_ projectID: UUID, update: (inout ProjectOperatorState) -> Void) {
        var state = states[projectID] ?? ProjectOperatorState(projectID: projectID)
        update(&state)
        states[projectID] = state
        persist()
    }

    private func persist() {
        store.save(states)
    }

    private func appendMessage(role: OperatorConsoleRole, text: String, projectID: UUID? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        consoleMessages.append(
            OperatorConsoleMessage(
                role: role,
                text: trimmed,
                projectID: projectID
            )
        )
        if consoleMessages.count > maxConsoleMessages {
            consoleMessages.removeFirst(consoleMessages.count - maxConsoleMessages)
        }
    }

    private func scanSummaryMessage(for project: Project, report: ProjectOperatorReport) -> String {
        var lines: [String] = []
        lines.append("\(project.name): \(report.overview)")
        lines.append("Last worked on: \(report.lastWorkedOn)")
        lines.append("Next: \(report.nextSuggestedAction)")
        if let question = report.questionForHuman?.trimmingCharacters(in: .whitespacesAndNewlines), !question.isEmpty {
            lines.append(question)
        }
        return lines.joined(separator: "\n")
    }

    private static func extractOperatorReply(from snapshot: String) -> String? {
        let lines = snapshot
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }

        var collected: [String] = []
        for line in lines.reversed() {
            guard !line.isEmpty else {
                if !collected.isEmpty { break }
                continue
            }

            if line.contains("❯") || line.hasSuffix("$") || line.hasSuffix("%") || line.hasSuffix("#") {
                if !collected.isEmpty { break }
                continue
            }

            collected.append(line)
            if collected.count == 6 {
                break
            }
        }

        return collected.reversed().joined(separator: "\n").nonEmpty
    }

    private static func extractQuestion(from snapshot: String) -> String? {
        snapshot
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .reversed()
            .first { line in
                let lowered = line.lowercased()
                return lowered.contains("needs_confirmation:") || lowered.contains("question_for_human:")
            }?
            .components(separatedBy: ":")
            .dropFirst()
            .joined(separator: ":")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty
    }

    private static func extractResultSummary(from snapshot: String) -> String? {
        snapshot
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .reversed()
            .first { line in
                guard !line.isEmpty else { return false }
                if line.contains("❯") || line.hasSuffix("$") || line.hasSuffix("%") || line.hasSuffix("#") {
                    return false
                }
                let lowered = line.lowercased()
                if lowered.hasPrefix("needs_confirmation:") || lowered.hasPrefix("question_for_human:") {
                    return false
                }
                return true
            }
    }

    private static func shellEscape(_ value: String) -> String {
        if value.isEmpty {
            return "''"
        }

        let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }
}
