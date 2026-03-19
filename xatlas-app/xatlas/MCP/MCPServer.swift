import Foundation
import Network

/// Minimal HTTP server for MCP tool access and iOS remote control.
/// Uses NWListener for a lightweight, dependency-free approach.
/// When remote access is enabled, advertises via Bonjour and serves REST endpoints for the iOS companion app.
final class MCPServer: @unchecked Sendable {
    static let shared = MCPServer()
    private var listener: NWListener?
    private let handler = MCPHandler()
    private let preferredPort: UInt16
    private(set) var boundPort: UInt16?
    private let stateFileURL: URL

    private init() {
        if let envPort = ProcessInfo.processInfo.environment["XATLAS_MCP_PORT"],
           let parsed = UInt16(envPort) {
            preferredPort = parsed
        } else {
            preferredPort = 9012
        }

        let supportDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support", isDirectory: true)
        stateFileURL = supportDirectory
            .appendingPathComponent("xatlas", isDirectory: true)
            .appendingPathComponent("mcp-server.json", isDirectory: false)
    }

    func start() {
        let candidatePorts = Array(preferredPort...(preferredPort + 5))

        for candidate in candidatePorts {
            do {
                let params = NWParameters.tcp
                listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: candidate)!)
                listener?.newConnectionHandler = { [weak self] conn in
                    self?.handleConnection(conn)
                }

                // Advertise via Bonjour when remote access is enabled
                if AppPreferences.shared.remoteAccessEnabled {
                    let hostName = ProcessInfo.processInfo.hostName
                        .components(separatedBy: ".").first ?? "mac"
                    listener?.service = NWListener.Service(name: "xatlas-\(hostName)", type: "_xatlas._tcp")
                }

                listener?.start(queue: .global(qos: .userInitiated))
                boundPort = candidate
                persistState(port: candidate)
                print("[MCP] Server listening on \(AppPreferences.shared.remoteAccessEnabled ? "0.0.0.0" : "localhost"):\(candidate)")
                return
            } catch {
                listener?.cancel()
                listener = nil
            }
        }

        print("[MCP] Failed to start on ports \(candidatePorts.map(String.init).joined(separator: ", "))")
    }

    func stop() {
        listener?.cancel()
        listener = nil
        boundPort = nil
        clearPersistedState()
    }

    /// Restart the server (e.g. when remote access setting changes)
    func restart() {
        stop()
        start()
    }

    // MARK: - Connection handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: .global(qos: .userInitiated))
        receiveData(on: connection, buffer: Data())
    }

    private func receiveData(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }

            let combinedBuffer = buffer + (data ?? Data())
            if let requestData = self.completeHTTPRequest(from: combinedBuffer) {
                self.processHTTPRequest(data: requestData, connection: connection)
                return
            }

            if isComplete || error != nil {
                connection.cancel()
                return
            }

            self.receiveData(on: connection, buffer: combinedBuffer)
        }
    }

    private func completeHTTPRequest(from data: Data) -> Data? {
        guard let headerRange = data.range(of: Data("\r\n\r\n".utf8)) else {
            return nil
        }

        let headerData = data.subdata(in: 0..<headerRange.lowerBound)
        guard let headerString = String(data: headerData, encoding: .utf8) else {
            return data
        }

        let contentLength = headerString
            .components(separatedBy: "\r\n")
            .first { $0.lowercased().hasPrefix("content-length:") }
            .flatMap { line in
                line.split(separator: ":", maxSplits: 1).last
                    .map(String.init)?
                    .trimmingCharacters(in: .whitespaces)
            }
            .flatMap(Int.init) ?? 0

        let bodyStart = headerRange.upperBound
        let expectedLength = bodyStart + contentLength
        guard data.count >= expectedLength else { return nil }
        return data.subdata(in: 0..<expectedLength)
    }

    // MARK: - Request routing

    private func processHTTPRequest(data: Data, connection: NWConnection) {
        guard let raw = String(data: data, encoding: .utf8) else {
            sendResponse(connection: connection, status: 400, body: "Bad Request")
            return
        }

        let lines = raw.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else {
            sendResponse(connection: connection, status: 400, body: "Bad Request")
            return
        }

        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            sendResponse(connection: connection, status: 400, body: "Bad Request")
            return
        }

        let method = String(parts[0])
        let path = String(parts[1])
        let headers = requestHeaders(from: lines.dropFirst())
        let body: String? = raw.range(of: "\r\n\r\n").map { String(raw[$0.upperBound...]) }

        // --- Health check (no auth) ---
        if path == "/health" {
            let port = boundPort ?? preferredPort
            sendResponse(connection: connection, status: 200, body: "{\"status\":\"ok\",\"app\":\"xatlas\",\"port\":\(port)}")
            return
        }

        // --- Pairing endpoint (no auth, uses code) ---
        if method == "POST" && path == "/auth/pair" {
            handlePair(body: body, connection: connection)
            return
        }

        // --- MCP protocol endpoints (no bearer auth, uses MCP-Session-Id) ---
        if path == "/mcp" {
            handleMCPRequest(method: method, headers: headers, body: body, connection: connection)
            return
        }

        // --- REST API endpoints (require bearer auth) ---
        if path.hasPrefix("/api/") {
            guard let token = extractBearerToken(from: headers),
                  PairingService.shared.isValid(token: token) else {
                sendResponse(connection: connection, status: 401, body: "{\"error\":\"unauthorized\"}")
                return
            }
            handleAPIRequest(method: method, path: path, headers: headers, body: body, connection: connection)
            return
        }

        sendResponse(connection: connection, status: 404, body: "Not Found")
    }

    // MARK: - MCP protocol (existing behavior)

    private func handleMCPRequest(method: String, headers: [String: String], body: String?, connection: NWConnection) {
        if method == "GET" {
            let sessionHeader = headers["mcp-session-id"].map { ["MCP-Session-Id": $0] } ?? [:]
            sendResponse(
                connection: connection,
                status: 200,
                body: ": connected\n\n",
                contentType: "text/event-stream",
                headers: sessionHeader.merging([
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no"
                ]) { _, new in new }
            )
            return
        }

        if method == "DELETE" {
            sendResponse(connection: connection, status: 200, body: "", headers: headers["mcp-session-id"].map { ["MCP-Session-Id": $0] } ?? [:])
            return
        }

        if method == "POST" {
            if let bodyStr = body, !bodyStr.isEmpty {
                switch handler.handle(json: bodyStr) {
                case .json(let responseBody, let headers):
                    sendResponse(connection: connection, status: 200, body: responseBody, headers: headers)
                case .accepted:
                    sendResponse(connection: connection, status: 202, body: "")
                }
            } else {
                sendResponse(connection: connection, status: 400, body: "No body")
            }
            return
        }

        sendResponse(connection: connection, status: 404, body: "Not Found")
    }

    // MARK: - Pairing

    private func handlePair(body: String?, connection: NWConnection) {
        guard let body, let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let code = json["code"] as? String,
              let deviceName = json["deviceName"] as? String else {
            sendResponse(connection: connection, status: 400, body: "{\"error\":\"code and deviceName are required\"}")
            return
        }

        let deviceId = json["deviceId"] as? String ?? UUID().uuidString

        if let token = PairingService.shared.pair(code: code, deviceName: deviceName, deviceId: deviceId) {
            let host = ProcessInfo.processInfo.hostName.components(separatedBy: ".").first ?? "mac"
            let port = boundPort ?? preferredPort
            let streamPort = StreamingServer.shared.boundPort ?? 0
            sendResponse(connection: connection, status: 200, body: "{\"token\":\"\(token)\",\"host\":\"\(Self.jsonEscape(host))\",\"mcpPort\":\(port),\"streamPort\":\(streamPort)}")
        } else {
            sendResponse(connection: connection, status: 403, body: "{\"error\":\"invalid pairing code\"}")
        }
    }

    // MARK: - REST API for iOS remote control

    private func handleAPIRequest(method: String, path: String, headers: [String: String], body: String?, connection: NWConnection) {
        switch (method, path) {
        case ("GET", "/api/state"):
            handleGetState(connection: connection)
        case ("GET", "/api/sessions"):
            handleGetSessions(connection: connection)
        case ("POST", "/api/send"):
            handleSendKeys(body: body, connection: connection)
        case let (_, p) where method == "GET" && p.hasPrefix("/api/snapshot/"):
            let sessionId = String(p.dropFirst("/api/snapshot/".count))
            handleGetSnapshot(sessionId: sessionId, connection: connection)
        default:
            sendResponse(connection: connection, status: 404, body: "{\"error\":\"not found\"}")
        }
    }

    private func handleGetState(connection: NWConnection) {
        let state = Self.buildWorkspaceState()
        sendResponse(connection: connection, status: 200, body: state)
    }

    private func handleGetSessions(connection: NWConnection) {
        let sessions = TerminalService.shared.sessions
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(sessions), let json = String(data: data, encoding: .utf8) {
            sendResponse(connection: connection, status: 200, body: json)
        } else {
            sendResponse(connection: connection, status: 500, body: "{\"error\":\"encoding failed\"}")
        }
    }

    private func handleSendKeys(body: String?, connection: NWConnection) {
        guard let body, let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sessionId = json["sessionId"] as? String else {
            sendResponse(connection: connection, status: 400, body: "{\"error\":\"sessionId required\"}")
            return
        }

        guard let session = TerminalService.shared.session(id: sessionId) else {
            sendResponse(connection: connection, status: 404, body: "{\"error\":\"session not found\"}")
            return
        }

        if let command = json["command"] as? String {
            TerminalService.shared.sendCommand(command, to: sessionId)
            sendResponse(connection: connection, status: 200, body: "{\"ok\":true}")
        } else if let keys = json["keys"] as? String {
            TmuxService.shared.sendKeys(session: session.tmuxSessionName, keys: keys, pressEnter: false)
            sendResponse(connection: connection, status: 200, body: "{\"ok\":true}")
        } else {
            sendResponse(connection: connection, status: 400, body: "{\"error\":\"command or keys required\"}")
        }
    }

    private func handleGetSnapshot(sessionId: String, connection: NWConnection) {
        guard let session = TerminalService.shared.session(id: sessionId) else {
            sendResponse(connection: connection, status: 404, body: "{\"error\":\"session not found\"}")
            return
        }

        if let snapshot = TmuxService.shared.capturePane(session: session.tmuxSessionName, lines: 500) {
            let escaped = Self.jsonEscape(snapshot)
            sendResponse(connection: connection, status: 200, body: "{\"ok\":true,\"snapshot\":\"\(escaped)\"}")
        } else {
            sendResponse(connection: connection, status: 200, body: "{\"ok\":false,\"error\":\"snapshot unavailable\"}")
        }
    }

    // MARK: - Workspace state builder

    static func buildWorkspaceState() -> String {
        let selectedSessionID: String? = {
            guard case .terminal(let sid) = DispatchQueue.main.sync(execute: { AppState.shared.selectedTab?.kind }) else { return nil }
            return sid
        }()
        let selectedProjectID = DispatchQueue.main.sync { AppState.shared.selectedProject?.id.uuidString ?? "" }
        let selectedTabID = DispatchQueue.main.sync { AppState.shared.selectedTab?.id ?? "" }
        let projectSurface = DispatchQueue.main.sync { AppState.shared.projectSurfaceMode.rawValue }
        let quickViewProjectID = DispatchQueue.main.sync { AppState.shared.dashboardQuickViewProjectID?.uuidString ?? "" }
        let operatorEvents = OperatorEventStore.shared.recentEvents(limit: 10)
        let projects = DispatchQueue.main.sync { AppState.shared.projects }.map {
            "{\"id\":\"\(jsonEscape($0.id.uuidString))\",\"name\":\"\(jsonEscape($0.name))\",\"path\":\"\(jsonEscape($0.path))\"}"
        }
        let sessions = TerminalService.shared.sessions.map {
            "{\"id\":\"\(jsonEscape($0.id))\",\"title\":\"\(jsonEscape($0.displayTitle))\",\"tmuxSession\":\"\(jsonEscape($0.tmuxSessionName))\",\"projectId\":\"\(jsonEscape($0.projectID?.uuidString ?? ""))\",\"cwd\":\"\(jsonEscape($0.currentDirectory ?? $0.workingDirectory ?? ""))\",\"state\":\"\(jsonEscape($0.activityState.rawValue))\",\"attention\":\($0.requiresAttention ? "true" : "false"),\"lastCommand\":\"\(jsonEscape($0.lastCommand ?? ""))\"}"
        }
        let iso = ISO8601DateFormatter()
        let eventSummary = operatorEvents.map {
            "{\"id\":\"\(jsonEscape($0.id.uuidString))\",\"timestamp\":\"\(jsonEscape(iso.string(from: $0.timestamp)))\",\"kind\":\"\(jsonEscape($0.kind.rawValue))\",\"sessionId\":\"\(jsonEscape($0.sessionID))\",\"sessionTitle\":\"\(jsonEscape($0.sessionTitle))\",\"projectId\":\"\(jsonEscape($0.projectID?.uuidString ?? ""))\",\"command\":\"\(jsonEscape($0.command))\",\"details\":\"\(jsonEscape($0.details ?? ""))\"}"
        }
        return "{\"selectedProjectId\":\"\(jsonEscape(selectedProjectID))\",\"selectedTabId\":\"\(jsonEscape(selectedTabID))\",\"selectedSessionId\":\"\(jsonEscape(selectedSessionID ?? ""))\",\"projectSurface\":\"\(jsonEscape(projectSurface))\",\"quickViewProjectId\":\"\(jsonEscape(quickViewProjectID))\",\"projects\":[\(projects.joined(separator: ","))],\"sessions\":[\(sessions.joined(separator: ","))],\"operatorEvents\":[\(eventSummary.joined(separator: ","))]}"
    }

    // MARK: - Helpers

    private func extractBearerToken(from headers: [String: String]) -> String? {
        guard let auth = headers["authorization"], auth.hasPrefix("Bearer ") else { return nil }
        return String(auth.dropFirst("Bearer ".count))
    }

    static func jsonEscape(_ string: String) -> String {
        string
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
    }

    private func requestHeaders(from lines: ArraySlice<Substring>) -> [String: String] {
        var headers: [String: String] = [:]

        for line in lines {
            guard !line.isEmpty else { break }
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let key = parts[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
            headers[key] = value
        }

        return headers
    }

    private func sendResponse(
        connection: NWConnection,
        status: Int,
        body: String,
        contentType: String = "application/json",
        headers: [String: String] = [:]
    ) {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 202: statusText = "Accepted"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 403: statusText = "Forbidden"
        case 404: statusText = "Not Found"
        case 500: statusText = "Internal Server Error"
        default: statusText = "Error"
        }

        let extraHeaders = headers
            .sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value)\r" }
            .joined(separator: "\n")
        let optionalHeaderBlock = extraHeaders.isEmpty ? "" : "\(extraHeaders)\n"

        let response = """
        HTTP/1.1 \(status) \(statusText)\r
        Content-Type: \(contentType)\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \(optionalHeaderBlock)\
        \r
        \(body)
        """

        connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func persistState(port: UInt16) {
        let directory = stateFileURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var payload: [String: Any] = [
                "port": Int(port),
                "url": "http://127.0.0.1:\(port)/mcp"
            ]
            if AppPreferences.shared.remoteAccessEnabled, let lanIP = Self.lanIPAddress() {
                payload["lanUrl"] = "http://\(lanIP):\(port)"
                payload["remoteAccess"] = true
            }
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: stateFileURL, options: .atomic)
        } catch {
            print("[MCP] Failed to persist state: \(error.localizedDescription)")
        }
    }

    private func clearPersistedState() {
        try? FileManager.default.removeItem(at: stateFileURL)
    }

    /// Get the primary LAN IPv4 address
    static func lanIPAddress() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let interface = ptr.pointee
            let family = interface.ifa_addr.pointee.sa_family
            guard family == UInt8(AF_INET) else { continue }

            let name = String(cString: interface.ifa_name)
            guard name == "en0" || name == "en1" else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len),
                           &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                return String(cString: hostname)
            }
        }
        return nil
    }
}
