import Foundation

typealias TerminalStreamBytesHandler = @Sendable (ArraySlice<UInt8>) -> Void
typealias TerminalStreamExitHandler = @Sendable (Int32?) -> Void

final class TerminalStreamService: @unchecked Sendable {
    static let shared = TerminalStreamService()

    private struct Subscriber: Sendable {
        let onBootstrap: TerminalStreamBytesHandler
        let onData: TerminalStreamBytesHandler
        let onExit: TerminalStreamExitHandler
        var hasBootstrapped: Bool
        var bufferedChunks: [Data]
    }

    private struct StreamState {
        let sessionName: String
        let paneID: String
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
        paneID: String,
        onBootstrap: @escaping TerminalStreamBytesHandler,
        onData: @escaping TerminalStreamBytesHandler,
        onExit: @escaping TerminalStreamExitHandler
    ) -> UUID {
        let token = UUID()

        queue.async { [service = self] in
            var state = service.streams[sessionID] ?? service.makeStreamState(
                sessionID: sessionID,
                sessionName: sessionName,
                paneID: paneID
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
            service.streams[sessionID] = state
            service.captureBootstrapSnapshot(for: sessionID, subscriberID: token, sessionName: sessionName)
        }

        return token
    }

    func unsubscribe(sessionID: String, subscriberID: UUID) {
        queue.async { [service = self] in
            guard var state = service.streams[sessionID] else { return }
            state.subscribers.removeValue(forKey: subscriberID)

            guard state.subscribers.isEmpty else {
                service.streams[sessionID] = state
                return
            }

            let workItem = service.makeShutdownWorkItem(for: sessionID)
            state.shutdownWorkItem = workItem
            service.streams[sessionID] = state
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + service.shutdownGracePeriod, execute: workItem)
        }
    }

    private func makeStreamState(sessionID: String, sessionName: String, paneID: String) -> StreamState {
        let backend = TmuxPipeTerminalBackend(sessionName: sessionName, paneID: paneID)
        backend.onData = { [service = self] bytes in
            service.handleLiveData(for: sessionID, bytes: bytes)
        }
        backend.onExit = { [service = self] status in
            service.handleExit(for: sessionID, status: status)
        }
        _ = backend.start(size: .init(cols: 0, rows: 0))

        return StreamState(
            sessionName: sessionName,
            paneID: paneID,
            backend: backend,
            subscribers: [:],
            shutdownWorkItem: nil
        )
    }

    private func makeShutdownWorkItem(for sessionID: String) -> DispatchWorkItem {
        DispatchWorkItem { [service = self] in
            service.queue.async { [service] in
                guard let state = service.streams[sessionID], state.subscribers.isEmpty else { return }
                state.backend.stop()
                service.streams.removeValue(forKey: sessionID)
            }
        }
    }

    private func captureBootstrapSnapshot(for sessionID: String, subscriberID: UUID, sessionName: String) {
        DispatchQueue.global(qos: .userInitiated).async { [service = self] in
            let data = service.snapshotData(for: sessionName) ?? Data()

            service.queue.async { [service] in
                guard let state = service.streams[sessionID],
                      var subscriber = state.subscribers[subscriberID],
                      !subscriber.hasBootstrapped else { return }

                let buffered = subscriber.bufferedChunks
                subscriber.bufferedChunks.removeAll(keepingCapacity: false)
                subscriber.hasBootstrapped = true

                var nextState = state
                nextState.subscribers[subscriberID] = subscriber
                service.streams[sessionID] = nextState

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

        queue.async { [service = self] in
            guard var state = service.streams[sessionID] else { return }

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

            service.streams[sessionID] = state

            guard !immediateSubscribers.isEmpty else { return }
            DispatchQueue.main.async {
                for subscriber in immediateSubscribers {
                    subscriber.onData(bytes)
                }
            }
        }
    }

    private func handleExit(for sessionID: String, status: Int32?) {
        queue.async { [service = self] in
            guard let state = service.streams.removeValue(forKey: sessionID) else { return }
            state.shutdownWorkItem?.cancel()
            let subscribers = Array(state.subscribers.values)
            DispatchQueue.main.async {
                for subscriber in subscribers {
                    subscriber.onExit(status)
                }
            }
        }
    }
}
