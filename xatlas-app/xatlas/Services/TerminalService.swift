import Foundation

@Observable
final class TerminalService {
    nonisolated(unsafe) static let shared = TerminalService()

    var sessions: [TerminalSession] = []

    private let tmux = TmuxService.shared
    private var completionMonitorTokens: [String: Int] = [:]

    func createSession(title: String? = nil, projectID: UUID? = nil, workingDirectory: String? = nil) -> TerminalSession {
        let sessionID = UUID().uuidString
        let tmuxSessionName = "xatlas_\(sessionID.prefix(8).lowercased())"
        let defaultTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? Self.defaultTitle(for: workingDirectory)

        var session = TerminalSession(
            id: sessionID,
            tmuxSessionName: tmuxSessionName,
            title: defaultTitle,
            pinnedTitle: nil,
            projectID: projectID,
            workingDirectory: workingDirectory,
            currentDirectory: workingDirectory,
            isActive: true,
            activityState: .idle,
            requiresAttention: false,
            lastCommand: nil,
            semanticTaskKey: nil
        )

        if tmux.isAvailable(), tmux.ensureSession(name: tmuxSessionName, cwd: workingDirectory, title: defaultTitle) {
            session.activityState = .idle
        } else {
            session.activityState = .error
        }

        sessions.append(session)
        notifyChange(for: session)
        return session
    }

    func removeSession(_ id: String, killTmux: Bool = false) {
        guard let session = session(id: id) else { return }
        completionMonitorTokens.removeValue(forKey: id)
        if killTmux {
            _ = tmux.killSession(name: session.tmuxSessionName)
        }
        sessions.removeAll { $0.id == id }
        notifyChange(for: session)
    }

    func session(id: String) -> TerminalSession? {
        sessions.first { $0.id == id }
    }

    func sessionsForProject(_ projectID: UUID?) -> [TerminalSession] {
        guard let projectID else {
            return sessions
        }
        return sessions.filter { $0.projectID == projectID }
    }

    func visibleSessionsForProject(_ projectID: UUID?, maxDetached: Int = 4) -> [TerminalSession] {
        let ordered = sessionsForProject(projectID)
            .filter { $0.activityState != .exited }
            .sorted(by: Self.sessionPriority)

        let active = ordered.filter { $0.activityState != .detached }
        let detached = ordered.filter { $0.activityState == .detached }
        return active + detached.prefix(maxDetached)
    }

    func hiddenSessionCountForProject(_ projectID: UUID?, maxDetached: Int = 4) -> Int {
        let visibleCount = visibleSessionsForProject(projectID, maxDetached: maxDetached).count
        let totalCount = sessionsForProject(projectID).filter { $0.activityState != .exited }.count
        return max(0, totalCount - visibleCount)
    }

    func displayTitle(for sessionID: String) -> String {
        session(id: sessionID)?.displayTitle ?? "Terminal"
    }

    func snapshot(for sessionID: String, lines: Int = 200) -> String? {
        guard let session = session(id: sessionID) else { return nil }
        return tmux.capturePane(session: session.tmuxSessionName, lines: lines)
    }

    func rehydrateSessions(projects: [Project]) {
        guard tmux.isAvailable() else { return }

        let liveSessions = tmux.listManagedSessions()
        let liveNames = Set(liveSessions.map(\.name))

        for descriptor in liveSessions {
            if let existingID = sessions.first(where: { $0.tmuxSessionName == descriptor.name })?.id {
                updateSession(existingID) { session in
                    if let title = descriptor.title?.nonEmpty, session.pinnedTitle == nil {
                        session.title = title
                    }
                    if let cwd = descriptor.currentDirectory?.nonEmpty {
                        session.currentDirectory = cwd
                        session.workingDirectory = session.workingDirectory ?? cwd
                    }
                    session.projectID = Self.matchingProjectID(
                        for: descriptor.currentDirectory,
                        in: projects
                    )
                    session.activityState = .detached
                    session.updatedAt = .now
                }
                continue
            }

            let currentDirectory = descriptor.currentDirectory?.nonEmpty
            let restored = TerminalSession(
                id: descriptor.name,
                tmuxSessionName: descriptor.name,
                title: descriptor.title?.nonEmpty ?? Self.defaultTitle(for: currentDirectory),
                pinnedTitle: nil,
                projectID: Self.matchingProjectID(for: currentDirectory, in: projects),
                workingDirectory: currentDirectory,
                currentDirectory: currentDirectory,
                isActive: true,
                activityState: .detached,
                requiresAttention: false,
                lastCommand: nil,
                semanticTaskKey: nil,
                createdAt: .now,
                updatedAt: .now
            )
            sessions.append(restored)
            notifyChange(for: restored)
        }

        for index in sessions.indices {
            if !liveNames.contains(sessions[index].tmuxSessionName) {
                sessions[index].activityState = .exited
            }
            sessions[index].projectID = Self.matchingProjectID(
                for: sessions[index].currentDirectory ?? sessions[index].workingDirectory,
                in: projects
            )
        }
    }

    @discardableResult
    func ensureBackingSession(for sessionID: String) -> Bool {
        guard let session = session(id: sessionID) else { return false }
        let success = tmux.ensureSession(
            name: session.tmuxSessionName,
            cwd: session.currentDirectory ?? session.workingDirectory,
            title: session.displayTitle
        )
        if success {
            updateActivityState(.idle, for: sessionID)
        } else {
            updateActivityState(.error, for: sessionID)
        }
        return success
    }

    @discardableResult
    func sendCommand(_ command: String, to sessionID: String) -> Bool {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let session = session(id: sessionID) else { return false }
        guard ensureBackingSession(for: sessionID) else { return false }

        let success = tmux.sendKeys(session: session.tmuxSessionName, keys: trimmed, pressEnter: true)
        if success {
            recordCommand(trimmed, for: sessionID)
            updateActivityState(.running, for: sessionID)
        } else {
            updateActivityState(.error, for: sessionID)
            OperatorEventStore.shared.record(
                kind: .commandFailed,
                session: session,
                command: trimmed,
                details: "tmux could not send the command"
            )
        }
        return success
    }

    func recordCommand(_ command: String, for sessionID: String) {
        let cleaned = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }

        var updatedSessionName: String?
        var updatedTitle: String?
        var currentSession: TerminalSession?

        updateSession(sessionID) { session in
            session.lastCommand = cleaned
            session.updatedAt = .now
            session.activityState = .running
            session.requiresAttention = false
            currentSession = session

            guard session.pinnedTitle == nil else { return }
            guard let semantic = TerminalTitleHeuristics.semanticKey(for: cleaned) else { return }
            let oldKey = session.semanticTaskKey
            if oldKey == semantic { return }

            session.semanticTaskKey = semantic
            let nextTitle = TerminalTitleHeuristics.displayTitle(
                for: cleaned,
                semanticKey: semantic,
                cwd: session.currentDirectory ?? session.workingDirectory
            )
            session.title = nextTitle
            updatedSessionName = session.tmuxSessionName
            updatedTitle = nextTitle
        }

        if let updatedSessionName, let updatedTitle {
            _ = tmux.setSessionTitle(name: updatedSessionName, title: updatedTitle)
        }

        if let currentSession {
            OperatorEventStore.shared.record(
                kind: .commandStarted,
                session: currentSession,
                command: cleaned
            )
        }

        startCompletionMonitor(for: sessionID, command: cleaned)
    }

    func updateCurrentDirectory(_ directory: String?, for sessionID: String) {
        guard let directory, !directory.isEmpty else { return }
        updateSession(sessionID) { session in
            session.currentDirectory = directory
            session.updatedAt = .now
        }
    }

    func syncFromTmux(for sessionID: String) {
        guard let session = session(id: sessionID) else { return }
        let directory = tmux.currentDirectory(for: session.tmuxSessionName)
        let title = tmux.sessionTitle(for: session.tmuxSessionName)

        updateSession(sessionID) { session in
            if let directory, !directory.isEmpty {
                session.currentDirectory = directory
            }
            if session.pinnedTitle == nil, let title, !title.isEmpty {
                session.title = title
            }
            session.updatedAt = .now
        }
    }

    func handleAttached(sessionID: String) {
        updateActivityState(.idle, for: sessionID)
        syncFromTmux(for: sessionID)
    }

    func handleProcessTerminated(sessionID: String) {
        guard let session = session(id: sessionID) else { return }
        let stillAlive = tmux.sessionExists(session.tmuxSessionName)
        updateActivityState(stillAlive ? .detached : .exited, for: sessionID)
        if stillAlive {
            syncFromTmux(for: sessionID)
        }
    }

    func updateActivityState(_ state: TerminalActivityState, for sessionID: String) {
        updateSession(sessionID) { session in
            session.activityState = state
            session.updatedAt = .now
        }
    }

    func clearAttention(for sessionID: String) {
        updateSession(sessionID) { session in
            session.requiresAttention = false
            session.updatedAt = .now
        }
    }

    private func updateSession(_ sessionID: String, mutate: (inout TerminalSession) -> Void) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        let previous = sessions[index]
        mutate(&sessions[index])
        guard sessions[index] != previous else { return }
        notifyChange(for: sessions[index])
    }

    private func notifyChange(for session: TerminalSession) {
        NotificationCenter.default.post(
            name: .xatlasTerminalSessionDidChange,
            object: self,
            userInfo: ["session": session]
        )
    }

    private func startCompletionMonitor(for sessionID: String, command: String) {
        let token = (completionMonitorTokens[sessionID] ?? 0) + 1
        completionMonitorTokens[sessionID] = token
        pollCompletion(sessionID: sessionID, token: token, remainingChecks: 150, lastTail: "", readyHits: 0)
    }

    private func markCommandFinished(for sessionID: String, observedTail: String) {
        completionMonitorTokens.removeValue(forKey: sessionID)

        var completedSession: TerminalSession?
        updateSession(sessionID) { session in
            guard session.activityState == .running else { return }
            session.activityState = .idle
            session.requiresAttention = true
            session.updatedAt = .now
            completedSession = session
        }

        if let completedSession, let command = completedSession.lastCommand {
            OperatorEventStore.shared.record(
                kind: .commandFinished,
                session: completedSession,
                command: command,
                details: Self.completionSummary(from: observedTail)
            )
        }
    }

    private static func relevantTail(from snapshot: String) -> String {
        snapshot
            .components(separatedBy: .newlines)
            .suffix(16)
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func completionSummary(from tail: String) -> String? {
        let lines = tail
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        return lines
            .reversed()
            .first { line in
                guard !(line.contains("❯") || line.hasSuffix("$") || line.hasSuffix("%") || line.hasSuffix("#")) else {
                    return false
                }
                let lowered = line.lowercased()
                if lowered == "codex" || lowered == "claude" || lowered == "zai" {
                    return false
                }
                if lowered.hasPrefix("mcp ") || lowered.hasPrefix("tokens used") || lowered.hasPrefix("session id:") {
                    return false
                }
                if lowered.hasPrefix("openai codex") || lowered.hasPrefix("workdir:") || lowered.hasPrefix("model:") {
                    return false
                }
                return true
            }
    }

    private static func snapshotShowsReadyState(_ snapshot: String) -> Bool {
        guard let line = snapshot
            .components(separatedBy: .newlines)
            .reversed()
            .first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?
            .trimmingCharacters(in: .whitespacesAndNewlines) else {
            return false
        }

        if line.contains("❯") || line.hasSuffix("$") || line.hasSuffix("%") || line.hasSuffix("#") {
            return true
        }

        if line.hasPrefix("› ") || line == ">" || line.hasPrefix("> ") {
            return true
        }

        return false
    }

    private func pollCompletion(
        sessionID: String,
        token: Int,
        remainingChecks: Int,
        lastTail: String,
        readyHits: Int
    ) {
        guard remainingChecks > 0 else {
            completionMonitorTokens.removeValue(forKey: sessionID)
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [sessionID, token, remainingChecks, lastTail, readyHits] in
            guard TerminalService.shared.completionMonitorTokens[sessionID] == token else { return }
            guard let snapshot = TerminalService.shared.snapshot(for: sessionID, lines: 60) else {
                TerminalService.shared.completionMonitorTokens.removeValue(forKey: sessionID)
                return
            }

            let tail = Self.relevantTail(from: snapshot)
            if Self.snapshotShowsReadyState(tail) {
                let nextHits = (tail == lastTail) ? (readyHits + 1) : 1
                if nextHits >= 2 {
                    TerminalService.shared.markCommandFinished(for: sessionID, observedTail: tail)
                    return
                }
                TerminalService.shared.pollCompletion(
                    sessionID: sessionID,
                    token: token,
                    remainingChecks: remainingChecks - 1,
                    lastTail: tail,
                    readyHits: nextHits
                )
                return
            }

            TerminalService.shared.pollCompletion(
                sessionID: sessionID,
                token: token,
                remainingChecks: remainingChecks - 1,
                lastTail: tail,
                readyHits: 0
            )
        }
    }

    private static func defaultTitle(for workingDirectory: String?) -> String {
        guard let workingDirectory, !workingDirectory.isEmpty else {
            return "Terminal"
        }
        return URL(fileURLWithPath: workingDirectory).lastPathComponent.nonEmpty ?? "Terminal"
    }

    private static func matchingProjectID(for directory: String?, in projects: [Project]) -> UUID? {
        guard let directory = directory?.nonEmpty else { return nil }
        return projects.first(where: { project in
            directory == project.path || directory.hasPrefix(project.path + "/")
        })?.id
    }

    private static func sessionPriority(_ lhs: TerminalSession, _ rhs: TerminalSession) -> Bool {
        let lhsRank = rank(for: lhs)
        let rhsRank = rank(for: rhs)
        if lhsRank != rhsRank {
            return lhsRank < rhsRank
        }
        return lhs.updatedAt > rhs.updatedAt
    }

    private static func rank(for session: TerminalSession) -> Int {
        if session.requiresAttention { return 0 }
        switch session.activityState {
        case .running: return 1
        case .idle: return 2
        case .detached: return 3
        case .error: return 4
        case .exited: return 5
        }
    }
}

private enum TerminalTitleHeuristics {
    private static let lowSignalCommands: Set<String> = [
        "ls", "ll", "la", "pwd", "clear", "history", "cd", "z", "exit"
    ]

    static func semanticKey(for command: String) -> String? {
        let tokens = tokenize(command)
        guard let executable = primaryExecutable(in: tokens) else { return nil }
        if lowSignalCommands.contains(executable) { return nil }

        switch executable {
        case "git":
            return "git"
        case "npm", "pnpm", "yarn", "bun":
            let action = preferredToken(tokens.dropFirst()) ?? "task"
            return "js:\(action)"
        case "cargo", "go", "swift", "xcodebuild", "make", "cmake", "python", "python3", "node", "deno":
            let action = preferredToken(tokens.dropFirst()) ?? executable
            return "\(executable):\(action)"
        case "claude", "codex", "opencode":
            return "agent:\(executable)"
        default:
            let action = preferredToken(tokens.dropFirst())
            return action.map { "\(executable):\($0)" } ?? executable
        }
    }

    static func displayTitle(for command: String, semanticKey: String, cwd: String?) -> String {
        let tokens = tokenize(command)
        let executable = primaryExecutable(in: tokens) ?? "task"
        let folder = cwd.flatMap { URL(fileURLWithPath: $0).lastPathComponent.nonEmpty }

        switch executable {
        case "git":
            return folder.map { "\($0) git" } ?? "git workflow"
        case "npm", "pnpm", "yarn", "bun":
            let action = preferredToken(tokens.dropFirst()) ?? "task"
            return folder.map { "\($0) \(action)" } ?? "\(executable) \(action)"
        case "cargo", "go", "swift", "xcodebuild", "make", "cmake":
            let action = preferredToken(tokens.dropFirst()) ?? executable
            return folder.map { "\($0) \(action)" } ?? "\(executable) \(action)"
        case "claude", "codex", "opencode":
            return folder.map { "\(executable) \($0)" } ?? executable
        default:
            let target = preferredToken(tokens.dropFirst())
            if let folder, let target, target != folder {
                return "\(folder) \(target)"
            }
            return folder ?? executable
        }
    }

    private static func tokenize(_ command: String) -> [String] {
        command
            .split(whereSeparator: { $0.isWhitespace || $0 == "|" || $0 == "&" || $0 == ";" })
            .map(String.init)
            .filter { !$0.isEmpty && !$0.hasPrefix("-") }
    }

    private static func primaryExecutable(in tokens: [String]) -> String? {
        for token in tokens {
            if token.contains("=") && !token.hasPrefix("./") && !token.hasPrefix("/") {
                continue
            }
            return URL(fileURLWithPath: token).lastPathComponent.lowercased()
        }
        return nil
    }

    private static func preferredToken<S: Sequence>(_ tokens: S) -> String? where S.Element == String {
        for token in tokens {
            let lowered = token.lowercased()
            if lowered.hasPrefix("-") { continue }
            if lowered == "run" || lowered == "exec" || lowered == "--" { continue }
            return URL(fileURLWithPath: lowered).lastPathComponent
        }
        return nil
    }
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
