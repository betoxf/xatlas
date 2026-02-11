import Foundation
import Network

/// Minimal HTTP server on localhost:9002 for MCP tool access.
/// Uses NWListener for a lightweight, dependency-free approach.
final class MCPServer: @unchecked Sendable {
    nonisolated(unsafe) static let shared = MCPServer()
    private var listener: NWListener?
    private let handler = MCPHandler()
    private let port: UInt16 = 9002

    func start() {
        do {
            let params = NWParameters.tcp
            listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
            listener?.newConnectionHandler = { [weak self] conn in
                self?.handleConnection(conn)
            }
            listener?.start(queue: .global(qos: .userInitiated))
            print("[MCP] Server listening on localhost:\(port)")
        } catch {
            print("[MCP] Failed to start: \(error)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: .global(qos: .userInitiated))
        receiveData(on: connection)
    }

    private func receiveData(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            if let data, let self {
                self.processHTTPRequest(data: data, connection: connection)
            }
            if isComplete || error != nil {
                connection.cancel()
            }
        }
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

        if path == "/health" {
            sendResponse(connection: connection, status: 200, body: "{\"status\":\"ok\",\"app\":\"xatlas\"}")
            return
        }

        if method == "POST" && path == "/mcp" {
            if let bodyRange = raw.range(of: "\r\n\r\n") {
                let bodyStr = String(raw[bodyRange.upperBound...])
                let responseBody = handler.handle(json: bodyStr)
                sendResponse(connection: connection, status: 200, body: responseBody)
            } else {
                sendResponse(connection: connection, status: 400, body: "No body")
            }
            return
        }

        sendResponse(connection: connection, status: 404, body: "Not Found")
    }

    private func sendResponse(connection: NWConnection, status: Int, body: String) {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 404: statusText = "Not Found"
        default: statusText = "Error"
        }

        let response = """
        HTTP/1.1 \(status) \(statusText)\r
        Content-Type: application/json\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \r
        \(body)
        """

        connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
