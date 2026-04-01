import Foundation
import Network

/// WebSocket server for streaming terminal output to iOS clients.
/// Runs on a separate port from MCPServer, using NWProtocolWebSocket for framing.
final class StreamingServer: @unchecked Sendable {
    static let shared = StreamingServer()

    private var listener: NWListener?
    private(set) var boundPort: UInt16?
    private let preferredPort: UInt16 = 9020
    private let queue = DispatchQueue(label: "xatlas.streaming", qos: .userInitiated)

    /// Active WebSocket connections keyed by session ID
    private var subscribers: [String: [WebSocketClient]] = [:]
    private let subscribersLock = NSLock()

    private init() {}

    func start() {
        let candidatePorts = Array(preferredPort...(preferredPort + 5))

        for candidate in candidatePorts {
            do {
                let params = NWParameters.tcp
                let wsOptions = NWProtocolWebSocket.Options()
                wsOptions.autoReplyPing = true
                params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

                listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: candidate)!)
                listener?.newConnectionHandler = { [weak self] conn in
                    self?.handleNewConnection(conn)
                }
                listener?.start(queue: queue)
                boundPort = candidate
                print("[Streaming] WebSocket server listening on port \(candidate)")
                return
            } catch {
                listener?.cancel()
                listener = nil
            }
        }

        print("[Streaming] Failed to start on ports \(candidatePorts.map(String.init).joined(separator: ", "))")
    }

    func stop() {
        listener?.cancel()
        listener = nil
        boundPort = nil

        subscribersLock.lock()
        for (_, clients) in subscribers {
            for client in clients {
                client.connection.cancel()
            }
        }
        subscribers.removeAll()
        subscribersLock.unlock()

        PipePaneManager.shared.stopAll()
    }

    // MARK: - Broadcast terminal data to subscribers

    func broadcast(sessionName: String, data: Data) {
        subscribersLock.lock()
        let clients = subscribers[sessionName] ?? []
        subscribersLock.unlock()

        let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
        let context = NWConnection.ContentContext(identifier: "binary", metadata: [metadata])

        for client in clients {
            client.connection.send(content: data, contentContext: context, completion: .contentProcessed { error in
                if error != nil {
                    self.removeClient(client)
                }
            })
        }
    }

    /// Send a JSON text frame to all subscribers of a session
    func broadcastText(sessionName: String, text: String) {
        subscribersLock.lock()
        let clients = subscribers[sessionName] ?? []
        subscribersLock.unlock()

        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])

        for client in clients {
            client.connection.send(content: text.data(using: .utf8), contentContext: context, completion: .contentProcessed { error in
                if error != nil {
                    self.removeClient(client)
                }
            })
        }
    }

    // MARK: - Connection handling

    private func handleNewConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveMessage(on: connection, client: nil)
    }

    private func receiveMessage(on connection: NWConnection, client: WebSocketClient?) {
        connection.receiveMessage { [weak self] data, context, isComplete, error in
            guard let self else { return }

            if error != nil {
                if let client { self.removeClient(client) }
                connection.cancel()
                return
            }

            guard let data, let context else {
                if isComplete {
                    if let client { self.removeClient(client) }
                    connection.cancel()
                }
                return
            }

            // Determine WebSocket opcode
            let metadata = context.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata

            if let metadata, metadata.opcode == .text, let text = String(data: data, encoding: .utf8) {
                self.handleTextMessage(text, connection: connection, client: client)
            } else if let metadata, metadata.opcode == .binary, let client {
                // Binary frame = raw keystrokes from iOS
                self.handleBinaryMessage(data, client: client)
            }

            // Continue receiving
            let currentClient = client ?? self.findClient(for: connection)
            self.receiveMessage(on: connection, client: currentClient)
        }
    }

    private func handleTextMessage(_ text: String, connection: NWConnection, client: WebSocketClient?) {
        guard let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "subscribe":
            guard let sessionId = json["sessionId"] as? String else { return }

            // Validate auth token
            guard let token = json["token"] as? String, PairingService.shared.isValid(token: token) else {
                let errorMsg = "{\"type\":\"error\",\"message\":\"unauthorized\"}"
                let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                let ctx = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
                connection.send(content: errorMsg.data(using: .utf8), contentContext: ctx, completion: .contentProcessed { _ in
                    connection.cancel()
                })
                return
            }

            // Find the session and its tmux name
            guard let session = TerminalService.shared.session(id: sessionId) else {
                let errorMsg = "{\"type\":\"error\",\"message\":\"session not found\"}"
                let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                let ctx = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
                connection.send(content: errorMsg.data(using: .utf8), contentContext: ctx, completion: .contentProcessed { _ in })
                return
            }

            let newClient = WebSocketClient(
                id: UUID().uuidString,
                connection: connection,
                sessionId: sessionId,
                tmuxSessionName: session.tmuxSessionName
            )

            addClient(newClient)
            sendInitialState(to: newClient, session: session)

        case "resize":
            guard let cols = json["cols"] as? Int, let rows = json["rows"] as? Int,
                  let client else { return }
            // Resize the tmux pane
            TmuxService.shared.resizePane(session: client.tmuxSessionName, cols: cols, rows: rows)

        default:
            break
        }
    }

    private func handleBinaryMessage(_ data: Data, client: WebSocketClient) {
        // Forward raw keystrokes to tmux
        if let keys = String(data: data, encoding: .utf8) {
            _ = TmuxService.shared.sendKeys(session: client.tmuxSessionName, keys: keys, pressEnter: false)
        }
    }

    private func sendInitialState(to client: WebSocketClient, session: TerminalSession) {
        // Send init text frame
        let initMsg = "{\"type\":\"init\",\"sessionId\":\"\(MCPServer.jsonEscape(session.id))\",\"title\":\"\(MCPServer.jsonEscape(session.displayTitle))\",\"state\":\"\(session.activityState.rawValue)\"}"
        let textMeta = NWProtocolWebSocket.Metadata(opcode: .text)
        let textCtx = NWConnection.ContentContext(identifier: "text", metadata: [textMeta])
        client.connection.send(content: initMsg.data(using: .utf8), contentContext: textCtx, completion: .contentProcessed { _ in })

        // Send initial capture-pane snapshot as binary frame
        if let snapshot = TmuxService.shared.capturePaneWithEscapes(session: session.tmuxSessionName, lines: 500),
           let snapshotData = snapshot.data(using: .utf8) {
            let binMeta = NWProtocolWebSocket.Metadata(opcode: .binary)
            let binCtx = NWConnection.ContentContext(identifier: "binary", metadata: [binMeta])
            client.connection.send(content: snapshotData, contentContext: binCtx, completion: .contentProcessed { _ in })
        }

        // Start pipe-pane streaming for this session
        PipePaneManager.shared.startStreaming(sessionName: session.tmuxSessionName)
    }

    // MARK: - Client management

    private func addClient(_ client: WebSocketClient) {
        subscribersLock.lock()
        subscribers[client.tmuxSessionName, default: []].append(client)
        subscribersLock.unlock()
    }

    private func removeClient(_ client: WebSocketClient) {
        subscribersLock.lock()
        subscribers[client.tmuxSessionName]?.removeAll { $0.id == client.id }
        let remaining = subscribers[client.tmuxSessionName]?.count ?? 0
        if remaining == 0 {
            subscribers.removeValue(forKey: client.tmuxSessionName)
        }
        subscribersLock.unlock()

        client.connection.cancel()

        // Stop pipe-pane if no more subscribers
        if remaining == 0 {
            PipePaneManager.shared.stopStreaming(sessionName: client.tmuxSessionName)
        }
    }

    private func findClient(for connection: NWConnection) -> WebSocketClient? {
        subscribersLock.lock()
        defer { subscribersLock.unlock() }
        for (_, clients) in subscribers {
            if let client = clients.first(where: { $0.connection === connection }) {
                return client
            }
        }
        return nil
    }
}

// MARK: - WebSocket client

final class WebSocketClient: @unchecked Sendable {
    let id: String
    let connection: NWConnection
    let sessionId: String
    let tmuxSessionName: String

    init(id: String, connection: NWConnection, sessionId: String, tmuxSessionName: String) {
        self.id = id
        self.connection = connection
        self.sessionId = sessionId
        self.tmuxSessionName = tmuxSessionName
    }
}
