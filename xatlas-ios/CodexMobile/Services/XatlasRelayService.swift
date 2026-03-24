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
            let raw = try await codex.callTool(name: "xatlas_workspace_state")
            guard let data = raw.data(using: .utf8) else {
                throw CodexServiceError.invalidResponse("xatlas_workspace_state returned invalid UTF-8")
            }

            let state = try JSONDecoder().decode(XatlasRelayWorkspaceState.self, from: data)
            selectedProjectId = state.selectedProjectId
            selectedSessionId = state.selectedSessionId
            projectSurface = state.projectSurface
            projects = state.projects
            sessions = state.sessions
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
        selectedProjectId = ""
        selectedSessionId = ""
        projectSurface = "dashboard"
    }
}

private struct XatlasRelayWorkspaceState: Codable {
    let selectedProjectId: String
    let selectedSessionId: String
    let projectSurface: String
    let projects: [XatlasProject]
    let sessions: [XatlasSession]
}

private struct XatlasRelayTerminalSnapshot: Codable {
    let ok: Bool
    let snapshot: String
}

private struct XatlasRelayCommandResult: Codable {
    let ok: Bool
}
