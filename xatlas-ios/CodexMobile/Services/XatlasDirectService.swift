// XatlasDirectService.swift
// Purpose: Direct LAN connection to the xatlas macOS app's REST API and streaming WebSocket.
// Bypasses the relay/bridge entirely — iPhone talks directly to the Mac on the same network.

import Foundation
import Observation
import UIKit

// MARK: - Models

struct XatlasProject: Identifiable, Decodable, Hashable {
    let id: String
    let name: String
    let path: String
}

struct XatlasSession: Identifiable, Decodable, Hashable {
    let id: String
    let title: String
    let tmuxSession: String
    let projectId: String
    let cwd: String
    let state: String
    let attention: Bool
    let lastCommand: String
}

extension XatlasSession {
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case tmuxSession
        case projectId
        case cwd
        case state
        case attention
        case lastCommand
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Terminal"
        tmuxSession = try container.decodeIfPresent(String.self, forKey: .tmuxSession) ?? id
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        cwd = try container.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        state = try container.decodeIfPresent(String.self, forKey: .state) ?? "idle"
        attention = try container.decodeIfPresent(Bool.self, forKey: .attention) ?? false
        lastCommand = try container.decodeIfPresent(String.self, forKey: .lastCommand) ?? ""
    }
}

struct XatlasWorkspaceState: Decodable {
    let selectedProjectId: String
    let selectedTabId: String
    let selectedSessionId: String
    let projectSurface: String
    let projects: [XatlasProject]
    let sessions: [XatlasSession]
}

struct XatlasLANPairingPayload {
    let host: String
    let port: Int
    let streamPort: Int
    let code: String
}

// MARK: - Connection State

enum XatlasConnectionState: Equatable {
    case disconnected
    case pairing
    case connecting
    case connected
    case error(String)
}

// MARK: - Service

@Observable
final class XatlasDirectService {
    static let shared = XatlasDirectService()

    // Connection state
    var connectionState: XatlasConnectionState = .disconnected
    var macHost: String = ""
    var mcpPort: Int = 0
    var streamPort: Int = 0
    var bearerToken: String = ""

    // Workspace data
    var projects: [XatlasProject] = []
    var sessions: [XatlasSession] = []
    var selectedProjectId: String = ""
    var selectedSessionId: String = ""

    // Terminal streaming
    var terminalOutput: String = ""
    private var streamSocket: URLSessionWebSocketTask?
    private var session: URLSession = URLSession.shared
    private var refreshTimer: Timer?

    private let keychainService = "com.xatlas.ios.direct"

    private init() {
        loadSavedConnection()
    }

    // MARK: - QR Pairing

    /// Parse a LAN QR code payload
    static func parseLANQR(_ string: String) -> XatlasLANPairingPayload? {
        guard let data = string.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let host = json["host"] as? String,
              let port = json["port"] as? Int,
              let code = json["code"] as? String else {
            return nil
        }
        let streamPort = json["streamPort"] as? Int ?? 0
        return XatlasLANPairingPayload(host: host, port: port, streamPort: streamPort, code: code)
    }

    /// Check if a QR string is a LAN format (vs relay format)
    static func isLANQR(_ string: String) -> Bool {
        guard let data = string.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        // LAN QR has "host" + "code", relay QR has "v" + "relay" + "sessionId"
        return json["host"] != nil && json["code"] != nil && json["v"] == nil
    }

    // MARK: - Connect Flow

    func pairAndConnect(payload: XatlasLANPairingPayload) async {
        connectionState = .pairing
        macHost = payload.host
        mcpPort = payload.port
        streamPort = payload.streamPort

        // Step 1: Pair with the Mac
        let deviceName = await UIDevice.current.name
        let deviceId = await UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString

        let pairBody: [String: Any] = [
            "code": payload.code,
            "deviceName": deviceName,
            "deviceId": deviceId
        ]

        guard let bodyData = try? JSONSerialization.data(withJSONObject: pairBody) else {
            connectionState = .error("Failed to build pairing request")
            return
        }

        let pairURL = URL(string: "http://\(macHost):\(mcpPort)/auth/pair")!
        var request = URLRequest(url: pairURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                connectionState = .error("Invalid response from Mac")
                return
            }

            if httpResponse.statusCode == 403 {
                connectionState = .error("Invalid pairing code. Check the code in xatlas Settings.")
                return
            }

            guard httpResponse.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = json["token"] as? String else {
                connectionState = .error("Pairing failed (status \(httpResponse.statusCode))")
                return
            }

            bearerToken = token
            if let sp = json["streamPort"] as? Int, sp > 0 {
                streamPort = sp
            }
            saveConnection()
            await fetchWorkspaceState()
        } catch {
            connectionState = .error("Cannot reach Mac: \(error.localizedDescription)")
        }
    }

    /// Reconnect to a previously paired Mac
    func reconnect() async {
        guard !macHost.isEmpty, !bearerToken.isEmpty else {
            connectionState = .disconnected
            return
        }
        connectionState = .connecting
        await fetchWorkspaceState()
    }

    // MARK: - REST API

    func fetchWorkspaceState() async {
        connectionState = .connecting

        guard let url = URL(string: "http://\(macHost):\(mcpPort)/api/state") else {
            connectionState = .error("Invalid Mac address")
            return
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 8

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                connectionState = .error("Invalid response")
                return
            }

            if httpResponse.statusCode == 401 {
                connectionState = .error("Token expired. Re-scan QR to pair again.")
                bearerToken = ""
                saveConnection()
                return
            }

            guard httpResponse.statusCode == 200 else {
                connectionState = .error("Server error (\(httpResponse.statusCode))")
                return
            }

            let decoder = JSONDecoder()
            let state = try decoder.decode(XatlasWorkspaceState.self, from: data)
            projects = state.projects
            sessions = state.sessions
            selectedProjectId = state.selectedProjectId
            selectedSessionId = state.selectedSessionId
            connectionState = .connected
            startAutoRefresh()
        } catch {
            connectionState = .error("Connection failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Terminal Snapshot

    func fetchSnapshot(sessionId: String) async -> String? {
        guard let url = URL(string: "http://\(macHost):\(mcpPort)/api/snapshot/\(sessionId)") else { return nil }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 8

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else { return nil }

        return String(data: data, encoding: .utf8)
    }

    // MARK: - Send Command

    func sendCommand(sessionId: String, command: String) async -> Bool {
        guard let url = URL(string: "http://\(macHost):\(mcpPort)/api/send") else { return false }

        let body: [String: Any] = ["sessionId": sessionId, "command": command]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return false }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = bodyData
        request.timeoutInterval = 8

        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else { return false }

        return true
    }

    func sendKeys(sessionId: String, keys: String) async -> Bool {
        guard let url = URL(string: "http://\(macHost):\(mcpPort)/api/send") else { return false }

        let body: [String: Any] = ["sessionId": sessionId, "keys": keys]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return false }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = bodyData
        request.timeoutInterval = 8

        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else { return false }

        return true
    }

    // MARK: - Terminal Streaming WebSocket

    func connectTerminalStream(sessionId: String, onOutput: @escaping (Data) -> Void) {
        guard streamPort > 0 else { return }

        let url = URL(string: "ws://\(macHost):\(streamPort)")!
        let wsTask = session.webSocketTask(with: url)
        streamSocket = wsTask
        wsTask.resume()

        // Subscribe to session
        let subscribeMsg: [String: Any] = [
            "type": "subscribe",
            "sessionId": sessionId,
            "token": bearerToken
        ]
        if let data = try? JSONSerialization.data(withJSONObject: subscribeMsg),
           let str = String(data: data, encoding: .utf8) {
            wsTask.send(.string(str)) { _ in }
        }

        receiveStreamMessages(task: wsTask, onOutput: onOutput)
    }

    private func receiveStreamMessages(task: URLSessionWebSocketTask, onOutput: @escaping (Data) -> Void) {
        task.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .data(let data):
                    onOutput(data)
                case .string(let text):
                    if let data = text.data(using: .utf8) {
                        onOutput(data)
                    }
                @unknown default:
                    break
                }
                self?.receiveStreamMessages(task: task, onOutput: onOutput)
            case .failure:
                break
            }
        }
    }

    func disconnectTerminalStream() {
        streamSocket?.cancel(with: .goingAway, reason: nil)
        streamSocket = nil
    }

    // MARK: - Auto Refresh

    private func startAutoRefresh() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            Task { [weak self] in
                await self?.fetchWorkspaceState()
            }
        }
    }

    func disconnect() {
        refreshTimer?.invalidate()
        refreshTimer = nil
        disconnectTerminalStream()
        connectionState = .disconnected
        projects = []
        sessions = []
        bearerToken = ""
        macHost = ""
        saveConnection()
    }

    // MARK: - Persistence

    private func saveConnection() {
        let info: [String: Any] = [
            "host": macHost,
            "mcpPort": mcpPort,
            "streamPort": streamPort,
            "token": bearerToken
        ]
        if let data = try? JSONSerialization.data(withJSONObject: info) {
            UserDefaults.standard.set(data, forKey: "xatlas_direct_connection")
        }
    }

    private func loadSavedConnection() {
        guard let data = UserDefaults.standard.data(forKey: "xatlas_direct_connection"),
              let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        macHost = info["host"] as? String ?? ""
        mcpPort = info["mcpPort"] as? Int ?? 0
        streamPort = info["streamPort"] as? Int ?? 0
        bearerToken = info["token"] as? String ?? ""
    }

    var isConfigured: Bool {
        !macHost.isEmpty && !bearerToken.isEmpty
    }

    func sessionsForProject(_ projectId: String) -> [XatlasSession] {
        sessions.filter { $0.projectId == projectId }
    }
}
