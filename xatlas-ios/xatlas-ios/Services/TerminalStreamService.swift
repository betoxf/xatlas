import Foundation

/// WebSocket client for streaming terminal data from the desktop.
/// Receives raw PTY bytes and forwards them for SwiftTerm rendering.
@Observable
final class TerminalStreamService: @unchecked Sendable {
    var isConnected = false

    /// Called with raw terminal bytes from the server
    var onData: (([UInt8]) -> Void)?

    /// Called with control messages (JSON text frames)
    var onControlMessage: (([String: Any]) -> Void)?

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private let queue = DispatchQueue(label: "xatlas.terminal-stream")

    func connect(host: String, streamPort: Int, sessionId: String, token: String) {
        disconnect()

        let urlString = "ws://\(host):\(streamPort)"
        guard let url = URL(string: urlString) else { return }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config)

        let task = session!.webSocketTask(with: url)
        webSocketTask = task
        task.resume()

        // Send subscribe message with auth
        let subscribe: [String: Any] = [
            "type": "subscribe",
            "sessionId": sessionId,
            "token": token
        ]
        if let data = try? JSONSerialization.data(withJSONObject: subscribe),
           let text = String(data: data, encoding: .utf8) {
            task.send(.string(text)) { [weak self] error in
                if let error {
                    print("[Stream] Subscribe send error: \(error)")
                    self?.handleDisconnect()
                }
            }
        }

        isConnected = true
        startReceiving()
    }

    func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
    }

    /// Send raw keystrokes to the desktop
    func sendKeys(_ bytes: [UInt8]) {
        guard let task = webSocketTask else { return }
        task.send(.data(Data(bytes))) { error in
            if let error {
                print("[Stream] Send error: \(error)")
            }
        }
    }

    /// Send a resize event
    func sendResize(cols: Int, rows: Int) {
        guard let task = webSocketTask else { return }
        let msg: [String: Any] = ["type": "resize", "cols": cols, "rows": rows]
        if let data = try? JSONSerialization.data(withJSONObject: msg),
           let text = String(data: data, encoding: .utf8) {
            task.send(.string(text)) { _ in }
        }
    }

    // MARK: - Receive loop

    private func startReceiving() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .success(let message):
                self?.handleMessage(message)
                self?.startReceiving() // Continue receiving
            case .failure(let error):
                print("[Stream] Receive error: \(error)")
                self?.handleDisconnect()
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .data(let data):
            // Binary frame = raw terminal output bytes
            let bytes = [UInt8](data)
            DispatchQueue.main.async { [weak self] in
                self?.onData?(bytes)
            }
        case .string(let text):
            // Text frame = control message (JSON)
            if let data = text.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                DispatchQueue.main.async { [weak self] in
                    self?.onControlMessage?(json)
                }
            }
        @unknown default:
            break
        }
    }

    private func handleDisconnect() {
        DispatchQueue.main.async { [weak self] in
            self?.isConnected = false
        }
    }
}
