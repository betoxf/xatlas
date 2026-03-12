import Foundation
import Network

/// Minimal HTTP server on localhost for MCP tool access.
/// Uses NWListener for a lightweight, dependency-free approach.
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
                listener?.start(queue: .global(qos: .userInitiated))
                boundPort = candidate
                persistState(port: candidate)
                print("[MCP] Server listening on localhost:\(candidate)")
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

        if path == "/health" {
            let port = boundPort ?? preferredPort
            sendResponse(connection: connection, status: 200, body: "{\"status\":\"ok\",\"app\":\"xatlas\",\"port\":\(port)}")
            return
        }

        if method == "GET" && path == "/mcp" {
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

        if method == "DELETE" && path == "/mcp" {
            sendResponse(connection: connection, status: 200, body: "", headers: headers["mcp-session-id"].map { ["MCP-Session-Id": $0] } ?? [:])
            return
        }

        if method == "POST" && path == "/mcp" {
            if let bodyRange = raw.range(of: "\r\n\r\n") {
                let bodyStr = String(raw[bodyRange.upperBound...])
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
        case 404: statusText = "Not Found"
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
            let payload = [
                "port": Int(port),
                "url": "http://127.0.0.1:\(port)/mcp"
            ] as [String: Any]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: stateFileURL, options: .atomic)
        } catch {
            print("[MCP] Failed to persist state: \(error.localizedDescription)")
        }
    }

    private func clearPersistedState() {
        try? FileManager.default.removeItem(at: stateFileURL)
    }
}
