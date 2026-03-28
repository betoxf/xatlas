import Foundation

final class TerminalStreamService: @unchecked Sendable {
    static let shared = TerminalStreamService()

    private struct Subscriber {
        let onBootstrap: @Sendable (ArraySlice<UInt8>) -> Void
        let onData: @Sendable (ArraySlice<UInt8>) -> Void
        let onExit: @Sendable (Int32?) -> Void
        var hasBootstrapped: Bool
        var bufferedChunks: [Data]
    }

    private struct StreamState {
        let backend: TmuxPipeTerminalBackend
        var subscribers: [UUID: Subscriber]
        var shutdownWorkItem: DispatchWorkItem?
    }

    private let queue = DispatchQueue(label: "com.xatlas.terminal-stream-service")
    private let shutdownGracePeriod: TimeInterval = 20
    private var streams: [String: StreamState] = [:]

    private init() {}

    func subscribe(
        sessionID: String,
        sessionName: String,
        onBootstrap: @escaping @Sendable (ArraySlice<UInt8>) -> Void,
        onData: @escaping @Sendable (ArraySlice<UInt8>) -> Void,
        onExit: @escaping @Sendable (Int32?) -> Void
    ) -> UUID {
        let token = UUID()

        queue.async { [weak self] in
            guard let self else { return }

            var state = self.streams[sessionID] ?? self.makeStreamState(
                sessionID: sessionID,
                sessionName: sessionName
            )

            state.shutdownWorkItem?.cancel()
            state.shutdownWorkItem = nil
            state.subscribers[token] = Subscriber(
                onBootstrap: onBootstrap,
                onData: onData,
                onExit: onExit,
                hasBootstrapped: false,
                bufferedChunks: []
            )
            self.streams[sessionID] = state
            self.captureBootstrapSnapshot(for: sessionID, subscriberID: token, sessionName: sessionName)
        }

        return token
    }

    func unsubscribe(sessionID: String, subscriberID: UUID) {
        queue.async { [weak self] in
            guard let self, var state = self.streams[sessionID] else { return }
            state.subscribers.removeValue(forKey: subscriberID)

            guard state.subscribers.isEmpty else {
                self.streams[sessionID] = state
                return
            }

            let workItem = DispatchWorkItem { [weak self] in
                self?.performPendingShutdown(for: sessionID)
            }

            state.shutdownWorkItem = workItem
            self.streams[sessionID] = state
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + self.shutdownGracePeriod, execute: workItem)
        }
    }

    private func makeStreamState(sessionID: String, sessionName: String) -> StreamState {
        let backend = TmuxPipeTerminalBackend(sessionName: sessionName)
        backend.onData = { [weak self] bytes in
            self?.handleLiveData(for: sessionID, bytes: bytes)
        }
        backend.onExit = { [weak self] status in
            self?.handleExit(for: sessionID, status: status)
        }
        backend.start()

        return StreamState(
            backend: backend,
            subscribers: [:],
            shutdownWorkItem: nil
        )
    }

    private func captureBootstrapSnapshot(for sessionID: String, subscriberID: UUID, sessionName: String) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let data = self.snapshotData(for: sessionName) ?? Data()

            self.queue.async {
                guard let state = self.streams[sessionID],
                      var subscriber = state.subscribers[subscriberID],
                      !subscriber.hasBootstrapped else { return }

                let buffered = subscriber.bufferedChunks
                subscriber.bufferedChunks.removeAll(keepingCapacity: false)
                subscriber.hasBootstrapped = true

                var nextState = state
                nextState.subscribers[subscriberID] = subscriber
                self.streams[sessionID] = nextState

                DispatchQueue.main.async {
                    subscriber.onBootstrap(ArraySlice(data))
                    for chunk in buffered {
                        subscriber.onData(ArraySlice(chunk))
                    }
                }
            }
        }
    }

    private func snapshotData(for sessionName: String) -> Data? {
        guard let snapshot = TmuxService.shared.capturePaneWithEscapes(session: sessionName, lines: 220)
                ?? TmuxService.shared.capturePane(session: sessionName, lines: 220) else {
            return nil
        }

        let trimmed = snapshot.trimmingCharacters(in: .newlines)
        guard !trimmed.isEmpty else { return nil }

        let normalized = trimmed
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\n", with: "\r\n")

        return Data(normalized.utf8)
    }

    private func handleLiveData(for sessionID: String, bytes: ArraySlice<UInt8>) {
        let data = Data(bytes)

        queue.async { [weak self] in
            guard let self, var state = self.streams[sessionID] else { return }

            var immediateSubscribers: [Subscriber] = []
            for (id, var subscriber) in state.subscribers {
                if subscriber.hasBootstrapped {
                    immediateSubscribers.append(subscriber)
                } else {
                    subscriber.bufferedChunks.append(data)
                    if subscriber.bufferedChunks.count > 24 {
                        subscriber.bufferedChunks.removeFirst(subscriber.bufferedChunks.count - 24)
                    }
                    state.subscribers[id] = subscriber
                }
            }

            self.streams[sessionID] = state

            guard !immediateSubscribers.isEmpty else { return }
            DispatchQueue.main.async {
                for subscriber in immediateSubscribers {
                    subscriber.onData(bytes)
                }
            }
        }
    }

    private func handleExit(for sessionID: String, status: Int32?) {
        queue.async { [weak self] in
            guard let self, let state = self.streams.removeValue(forKey: sessionID) else { return }
            state.shutdownWorkItem?.cancel()
            let subscribers = Array(state.subscribers.values)
            DispatchQueue.main.async {
                for subscriber in subscribers {
                    subscriber.onExit(status)
                }
            }
        }
    }

    private func performPendingShutdown(for sessionID: String) {
        queue.async { [weak self] in
            guard let self, let state = self.streams[sessionID], state.subscribers.isEmpty else { return }
            state.backend.stop()
            self.streams.removeValue(forKey: sessionID)
        }
    }
}
