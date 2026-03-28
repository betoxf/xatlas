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
        let clients = subscribers.values.flatMap { $0 }
        subscribers.removeAll()
        subscribersLock.unlock()

        for client in clients {
            unsubscribe(client)
            client.connection.cancel()
        }
    }

    // MARK: - Broadcast terminal data to subscribers

    func broadcast(sessionName: String, data: Data) {
        subscribersLock.lock()
        let clients = subscribers[sessionName] ?? []
        subscribersLock.unlock()

        for client in clients {
            sendBinary(data, to: client)
        }
    }

    /// Send a JSON text frame to all subscribers of a session
    func broadcastText(sessionName: String, text: String) {
        subscribersLock.lock()
        let clients = subscribers[sessionName] ?? []
        subscribersLock.unlock()

        for client in clients {
            sendText(text, to: client)
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

            guard TerminalService.shared.ensureBackingSession(for: session.id),
                  let paneID = TmuxService.shared.paneIdentifier(for: session.tmuxSessionName) else {
                let errorMsg = "{\"type\":\"error\",\"message\":\"session unavailable\"}"
                let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                let ctx = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
                connection.send(content: errorMsg.data(using: .utf8), contentContext: ctx, completion: .contentProcessed { _ in })
                return
            }

            let newClient = WebSocketClient(
                id: UUID().uuidString,
                connection: connection,
                sessionId: sessionId,
                tmuxSessionName: session.tmuxSessionName,
                paneID: paneID
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
        _ = TmuxService.shared.sendHexInput(toPane: client.paneID, bytes: Array(data))
    }

    private func sendInitialState(to client: WebSocketClient, session: TerminalSession) {
        // Send init text frame
        let initMsg = "{\"type\":\"init\",\"sessionId\":\"\(MCPServer.jsonEscape(session.id))\",\"title\":\"\(MCPServer.jsonEscape(session.displayTitle))\",\"state\":\"\(session.activityState.rawValue)\"}"
        sendText(initMsg, to: client)
        client.streamSubscriptionID = TerminalStreamService.shared.subscribe(
            sessionID: session.id,
            sessionName: session.tmuxSessionName,
            onBootstrap: { [weak self, weak client] bytes in
                guard let self, let client else { return }
                self.sendBinary(Data(bytes), to: client)
            },
            onData: { [weak self, weak client] bytes in
                guard let self, let client else { return }
                self.sendBinary(Data(bytes), to: client)
            },
            onExit: { [weak self, weak client] _ in
                guard let self, let client else { return }
                self.removeClient(client)
            }
        )
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
        if subscribers[client.tmuxSessionName]?.isEmpty == true {
            subscribers.removeValue(forKey: client.tmuxSessionName)
        }
        subscribersLock.unlock()

        unsubscribe(client)
        client.connection.cancel()
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

    private func unsubscribe(_ client: WebSocketClient) {
        guard let token = client.streamSubscriptionID else { return }
        client.streamSubscriptionID = nil
        TerminalStreamService.shared.unsubscribe(sessionID: client.sessionId, subscriberID: token)
    }

    private func sendText(_ text: String, to client: WebSocketClient) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        client.connection.send(content: text.data(using: .utf8), contentContext: context, completion: .contentProcessed { [weak self] error in
            if error != nil {
                self?.removeClient(client)
            }
        })
    }

    private func sendBinary(_ data: Data, to client: WebSocketClient) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
        let context = NWConnection.ContentContext(identifier: "binary", metadata: [metadata])
        client.connection.send(content: data, contentContext: context, completion: .contentProcessed { [weak self] error in
            if error != nil {
                self?.removeClient(client)
            }
        })
    }
}

// MARK: - WebSocket client

final class WebSocketClient: @unchecked Sendable {
    let id: String
    let connection: NWConnection
    let sessionId: String
    let tmuxSessionName: String
    let paneID: String
    var streamSubscriptionID: UUID?

    init(id: String, connection: NWConnection, sessionId: String, tmuxSessionName: String, paneID: String) {
        self.id = id
        self.connection = connection
        self.sessionId = sessionId
        self.tmuxSessionName = tmuxSessionName
        self.paneID = paneID
    }
}
