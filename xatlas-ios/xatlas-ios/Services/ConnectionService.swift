import Foundation

/// HTTP client for communicating with the xatlas desktop REST API.
final class ConnectionService: Sendable {
    let host: String
    let port: Int
    let token: String

    private var baseURL: String { "http://\(host):\(port)" }

    init(host: String, port: Int, token: String) {
        self.host = host
        self.port = port
        self.token = token
    }

    // MARK: - Pairing (static, no token needed)

    static func pair(host: String, port: Int, code: String, deviceName: String) async throws -> ConnectionInfo {
        let url = URL(string: "http://\(host):\(port)/auth/pair")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10

        let body: [String: Any] = [
            "code": code,
            "deviceName": deviceName,
            "deviceId": deviceId()
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ConnectionError.invalidResponse
        }

        guard httpResponse.statusCode == 200 else {
            if httpResponse.statusCode == 403 {
                throw ConnectionError.invalidCode
            }
            throw ConnectionError.serverError(httpResponse.statusCode)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String,
              let hostName = json["host"] as? String else {
            throw ConnectionError.invalidResponse
        }

        let streamPort = json["streamPort"] as? Int ?? 0
        let mcpPort = json["mcpPort"] as? Int ?? port

        return ConnectionInfo(
            host: host,
            port: mcpPort,
            streamPort: streamPort,
            token: token,
            hostName: hostName
        )
    }

    // MARK: - State

    func fetchState() async throws -> RemoteWorkspaceState {
        let data = try await get("/api/state")
        return try JSONDecoder().decode(RemoteWorkspaceState.self, from: data)
    }

    func fetchSessions() async throws -> [TerminalSession] {
        let data = try await get("/api/sessions")
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([TerminalSession].self, from: data)
    }

    func fetchSnapshot(sessionId: String) async throws -> String? {
        let data = try await get("/api/snapshot/\(sessionId)")
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ok = json["ok"] as? Bool, ok,
              let snapshot = json["snapshot"] as? String else { return nil }
        return snapshot
    }

    // MARK: - Commands

    func sendCommand(sessionId: String, command: String) async throws {
        let body: [String: Any] = ["sessionId": sessionId, "command": command]
        try await post("/api/send", body: body)
    }

    func sendKeys(sessionId: String, keys: String) async throws {
        let body: [String: Any] = ["sessionId": sessionId, "keys": keys]
        try await post("/api/send", body: body)
    }

    // MARK: - HTTP helpers

    private func get(_ path: String) async throws -> Data {
        let url = URL(string: baseURL + path)!
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return data
    }

    @discardableResult
    private func post(_ path: String, body: [String: Any]) async throws -> Data {
        let url = URL(string: baseURL + path)!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return data
    }

    private func validateResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw ConnectionError.invalidResponse
        }
        if http.statusCode == 401 {
            throw ConnectionError.unauthorized
        }
        guard (200...299).contains(http.statusCode) else {
            throw ConnectionError.serverError(http.statusCode)
        }
    }

    private static func deviceId() -> String {
        UUID().uuidString
    }
}

enum ConnectionError: LocalizedError {
    case invalidCode
    case invalidResponse
    case unauthorized
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .invalidCode: "Invalid pairing code"
        case .invalidResponse: "Invalid response from server"
        case .unauthorized: "Session expired — please re-pair"
        case .serverError(let code): "Server error (\(code))"
        }
    }
}
