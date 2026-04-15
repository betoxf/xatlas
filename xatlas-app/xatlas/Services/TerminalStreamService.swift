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
    }

    private struct StreamState {
        let sessionName: String
        let paneID: String
        let backend: TmuxPipeTerminalBackend
        var subscribers: [UUID: Subscriber]
        var bootstrapSnapshot: Data?
        var recentChunks: [Data]
        var bootstrapCaptureInFlight: Bool
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
                hasBootstrapped: false
            )
            service.streams[sessionID] = state
            service.bootstrapIfNeeded(for: sessionID, subscriberID: token)
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
            bootstrapSnapshot: nil,
            recentChunks: [],
            bootstrapCaptureInFlight: false,
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

    private func bootstrapIfNeeded(for sessionID: String, subscriberID: UUID) {
        guard let state = streams[sessionID],
              let subscriber = state.subscribers[subscriberID] else { return }

        if let bootstrapSnapshot = state.bootstrapSnapshot {
            var nextState = state
            nextState.subscribers[subscriberID]?.hasBootstrapped = true
            streams[sessionID] = nextState
            deliverBootstrap(
                to: subscriber,
                snapshot: bootstrapSnapshot,
                replayChunks: state.recentChunks
            )
            return
        }

        guard !state.bootstrapCaptureInFlight else { return }
        streams[sessionID]?.bootstrapCaptureInFlight = true
        captureBootstrapSnapshot(for: sessionID, sessionName: state.sessionName)
    }

    private func captureBootstrapSnapshot(for sessionID: String, sessionName: String) {
        DispatchQueue.global(qos: .userInitiated).async { [service = self] in
            let data = service.snapshotData(for: sessionName) ?? Data()

            service.queue.async { [service] in
                guard var state = service.streams[sessionID] else { return }
                state.bootstrapSnapshot = data
                state.bootstrapCaptureInFlight = false

                let replayChunks = state.recentChunks
                let targetSubscribers = state.subscribers.compactMap { id, subscriber -> Subscriber? in
                    guard !subscriber.hasBootstrapped else { return nil }
                    state.subscribers[id]?.hasBootstrapped = true
                    return subscriber
                }

                service.streams[sessionID] = state

                guard !targetSubscribers.isEmpty else { return }
                for subscriber in targetSubscribers {
                    service.deliverBootstrap(
                        to: subscriber,
                        snapshot: data,
                        replayChunks: replayChunks
                    )
                }
            }
        }
    }

    private func deliverBootstrap(to subscriber: Subscriber, snapshot: Data, replayChunks: [Data]) {
        DispatchQueue.main.async {
            subscriber.onBootstrap(ArraySlice(snapshot))
            for chunk in replayChunks {
                subscriber.onData(ArraySlice(chunk))
            }
        }
    }

    private func appendRecentChunk(_ data: Data, to state: inout StreamState) {
        state.recentChunks.append(data)
        if state.recentChunks.count > 24 {
            state.recentChunks.removeFirst(state.recentChunks.count - 24)
        }
    }

    private func handleLiveData(for sessionID: String, bytes: ArraySlice<UInt8>) {
        let data = Data(bytes)

        queue.async { [service = self] in
            guard var state = service.streams[sessionID] else { return }
            service.appendRecentChunk(data, to: &state)

            let immediateSubscribers = state.subscribers.values.filter(\.hasBootstrapped)
            service.streams[sessionID] = state

            guard !immediateSubscribers.isEmpty else { return }
            DispatchQueue.main.async {
                for subscriber in immediateSubscribers {
                    subscriber.onData(bytes)
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
