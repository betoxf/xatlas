// FILE: XatlasRelayService.swift
// Purpose: Bridges the xatlas relay runtime into workspace/session state for the iPhone UI.
// Layer: Service
// Exports: XatlasRelayService
// Depends on: Foundation, Observation, CodexService

import Foundation
import Observation

@MainActor
@Observable
final class XatlasRelayService {
    enum ConnectionState: Equatable {
        case disconnected
        case loading
        case connected
        case error(String)
    }

    var connectionState: ConnectionState = .disconnected
    var projects: [XatlasProject] = []
    var sessions: [XatlasSession] = []
    var operatorEvents: [XatlasOperatorEvent] = []
    var selectedProjectId: String = ""
    var selectedSessionId: String = ""
    var projectSurface: String = "dashboard"

    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    func activate(codex: CodexService) async {
        guard codex.isConnected, codex.isXatlasRuntime else {
            reset()
            return
        }

        await refreshWorkspaceState(codex: codex)
        startAutoRefresh(codex: codex)
    }

    func deactivate() {
        refreshTask?.cancel()
        refreshTask = nil
        reset()
    }

    func refreshWorkspaceState(codex: CodexService) async {
        guard codex.isConnected, codex.isXatlasRuntime else {
            reset()
            return
        }

        if connectionState == .disconnected {
            connectionState = .loading
        }

        do {
            async let workspaceStateRaw = codex.callTool(name: "xatlas_workspace_state")
            async let operatorFeedRaw = codex.callTool(
                name: "xatlas_operator_feed",
                arguments: ["limit": .integer(12)]
            )

            let raw = try await workspaceStateRaw
            guard let workspaceData = raw.data(using: .utf8) else {
                throw CodexServiceError.invalidResponse("xatlas_workspace_state returned invalid UTF-8")
            }

            let state = try JSONDecoder().decode(XatlasRelayWorkspaceState.self, from: workspaceData)
            selectedProjectId = state.selectedProjectId
            selectedSessionId = state.selectedSessionId
            projectSurface = state.projectSurface
            projects = state.projects
            sessions = state.sessions
            operatorEvents = state.operatorEvents

            if let feedText = try? await operatorFeedRaw,
               let feedData = feedText.data(using: .utf8),
               let decodedFeed = try? JSONDecoder().decode([XatlasOperatorEvent].self, from: feedData),
               !decodedFeed.isEmpty {
                operatorEvents = decodedFeed
            }
            connectionState = .connected
        } catch {
            connectionState = .error(error.localizedDescription)
        }
    }

    func fetchSnapshot(codex: CodexService, sessionId: String, lines: Int = 200) async -> String? {
        do {
            let raw = try await codex.callTool(
                name: "xatlas_terminal_snapshot",
                arguments: [
                    "sessionId": .string(sessionId),
                    "lines": .integer(lines),
                ]
            )
            guard let data = raw.data(using: .utf8) else { return nil }
            let snapshot = try JSONDecoder().decode(XatlasRelayTerminalSnapshot.self, from: data)
            return snapshot.ok ? snapshot.snapshot : nil
        } catch {
            return nil
        }
    }

    func sendCommand(codex: CodexService, sessionId: String, command: String) async -> Bool {
        do {
            let raw = try await codex.callTool(
                name: "xatlas_terminal_send",
                arguments: [
                    "sessionId": .string(sessionId),
                    "command": .string(command),
                ]
            )
            guard let data = raw.data(using: .utf8) else { return false }
            let result = try JSONDecoder().decode(XatlasRelayCommandResult.self, from: data)
            return result.ok
        } catch {
            return false
        }
    }

    func selectSession(codex: CodexService, sessionId: String) async {
        _ = try? await codex.callTool(
            name: "xatlas_terminal_select",
            arguments: ["sessionId": .string(sessionId)]
        )
        await refreshWorkspaceState(codex: codex)
    }

    func selectProject(codex: CodexService, projectId: String) async {
        _ = try? await codex.callTool(
            name: "xatlas_project_select",
            arguments: ["projectId": .string(projectId)]
        )
        await refreshWorkspaceState(codex: codex)
    }

    func retryLastCommand(codex: CodexService, sessionId: String) async -> Bool {
        do {
            let raw = try await codex.callTool(
                name: "xatlas_operator_retry",
                arguments: ["sessionId": .string(sessionId)]
            )
            guard let data = raw.data(using: .utf8) else { return false }
            let result = try JSONDecoder().decode(XatlasRelayActionResult.self, from: data)
            return result.ok
        } catch {
            return false
        }
    }

    func clearAttention(codex: CodexService, sessionId: String) async -> Bool {
        do {
            let raw = try await codex.callTool(
                name: "xatlas_operator_clear_attention",
                arguments: ["sessionId": .string(sessionId)]
            )
            guard let data = raw.data(using: .utf8) else { return false }
            let result = try JSONDecoder().decode(XatlasRelayActionResult.self, from: data)
            return result.ok
        } catch {
            return false
        }
    }

    func sessionsForProject(_ projectId: String) -> [XatlasSession] {
        sessions.filter { $0.projectId == projectId }
    }

    private func startAutoRefresh(codex: CodexService) {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor [weak self, weak codex] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled, let self, let codex else { return }
                guard codex.isConnected, codex.isXatlasRuntime else {
                    self.reset()
                    return
                }
                await self.refreshWorkspaceState(codex: codex)
            }
        }
    }

    private func reset() {
        refreshTask?.cancel()
        refreshTask = nil
        connectionState = .disconnected
        projects = []
        sessions = []
        operatorEvents = []
        selectedProjectId = ""
        selectedSessionId = ""
        projectSurface = "dashboard"
    }
}

private struct XatlasRelayWorkspaceState: Decodable {
    let selectedProjectId: String
    let selectedSessionId: String
    let projectSurface: String
    let projects: [XatlasProject]
    let sessions: [XatlasSession]
    let operatorEvents: [XatlasOperatorEvent]
}

private struct XatlasRelayTerminalSnapshot: Decodable {
    let ok: Bool
    let snapshot: String
}

private struct XatlasRelayCommandResult: Decodable {
    let ok: Bool
}

private struct XatlasRelayActionResult: Decodable {
    let ok: Bool
}

enum XatlasOperatorEventKind: String, Decodable {
    case commandStarted
    case commandFinished
    case commandFailed
}

struct XatlasOperatorEvent: Identifiable, Decodable, Equatable {
    let id: String
    let timestamp: String
    let kind: XatlasOperatorEventKind
    let projectId: String
    let projectName: String
    let sessionId: String
    let sessionTitle: String
    let command: String
    let details: String
}

extension XatlasRelayWorkspaceState {
    enum CodingKeys: String, CodingKey {
        case selectedProjectId
        case selectedSessionId
        case projectSurface
        case projects
        case sessions
        case operatorEvents
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        selectedProjectId = try container.decodeIfPresent(String.self, forKey: .selectedProjectId) ?? ""
        selectedSessionId = try container.decodeIfPresent(String.self, forKey: .selectedSessionId) ?? ""
        projectSurface = try container.decodeIfPresent(String.self, forKey: .projectSurface) ?? "dashboard"
        projects = try container.decodeIfPresent([XatlasProject].self, forKey: .projects) ?? []
        sessions = try container.decodeIfPresent([XatlasSession].self, forKey: .sessions) ?? []
        operatorEvents = try container.decodeIfPresent([XatlasOperatorEvent].self, forKey: .operatorEvents) ?? []
    }
}

extension XatlasOperatorEvent {
    enum CodingKeys: String, CodingKey {
        case id
        case timestamp
        case kind
        case projectId
        case projectName
        case sessionId
        case sessionTitle
        case command
        case details
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        timestamp = try container.decodeIfPresent(String.self, forKey: .timestamp) ?? ""
        kind = try container.decodeIfPresent(XatlasOperatorEventKind.self, forKey: .kind) ?? .commandStarted
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        projectName = try container.decodeIfPresent(String.self, forKey: .projectName) ?? ""
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        sessionTitle = try container.decodeIfPresent(String.self, forKey: .sessionTitle) ?? "Terminal"
        command = try container.decodeIfPresent(String.self, forKey: .command) ?? ""
        details = try container.decodeIfPresent(String.self, forKey: .details) ?? ""
    }
}
