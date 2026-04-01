import Foundation

/// Manages tmux pipe-pane for streaming terminal output to iOS clients.
/// Creates FIFOs per-session, reads them asynchronously, and broadcasts via StreamingServer.
final class PipePaneManager: @unchecked Sendable {
    static let shared = PipePaneManager()

    private let lock = NSLock()
    private var activeStreams: [String: StreamState] = [:]

    private struct StreamState {
        let fifoPath: String
        let fileHandle: FileHandle
        var refCount: Int
    }

    private init() {}

    /// Start streaming a tmux session's output. Safe to call multiple times (ref-counted).
    func startStreaming(sessionName: String) {
        lock.lock()
        if var existing = activeStreams[sessionName] {
            existing.refCount += 1
            activeStreams[sessionName] = existing
            lock.unlock()
            return
        }
        lock.unlock()

        let fifoPath = "/tmp/xatlas_stream_\(sessionName)"

        // Clean up any stale FIFO
        unlink(fifoPath)

        // Create FIFO
        guard mkfifo(fifoPath, 0o600) == 0 else {
            print("[PipePane] Failed to create FIFO at \(fifoPath): \(String(cString: strerror(errno)))")
            return
        }

        // Start tmux pipe-pane to write into the FIFO
        let tmux = TmuxService.shared
        guard tmux.pipePaneStart(session: sessionName, target: fifoPath) else {
            print("[PipePane] Failed to start pipe-pane for \(sessionName)")
            unlink(fifoPath)
            return
        }

        // Open FIFO for reading (this blocks until pipe-pane opens the write end,
        // so do it on a background thread)
        let manager = self
        DispatchQueue.global(qos: .userInitiated).async {
            guard let fileHandle = FileHandle(forReadingAtPath: fifoPath) else {
                print("[PipePane] Failed to open FIFO for reading: \(fifoPath)")
                tmux.pipePaneStop(session: sessionName)
                unlink(fifoPath)
                return
            }

            manager.lock.lock()
            manager.activeStreams[sessionName] = StreamState(
                fifoPath: fifoPath,
                fileHandle: fileHandle,
                refCount: 1
            )
            manager.lock.unlock()

            // Set up async reading
            fileHandle.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else {
                    // EOF — pipe-pane stopped or session ended
                    manager.cleanupStream(sessionName: sessionName)
                    return
                }
                StreamingServer.shared.broadcast(sessionName: sessionName, data: data)
            }
        }
    }

    /// Decrement ref count and stop streaming when no subscribers remain.
    func stopStreaming(sessionName: String) {
        lock.lock()
        guard var state = activeStreams[sessionName] else {
            lock.unlock()
            return
        }

        state.refCount -= 1
        if state.refCount > 0 {
            activeStreams[sessionName] = state
            lock.unlock()
            return
        }

        activeStreams.removeValue(forKey: sessionName)
        lock.unlock()

        teardown(state: state, sessionName: sessionName)
    }

    /// Stop all active streams (called on server shutdown).
    func stopAll() {
        lock.lock()
        let all = activeStreams
        activeStreams.removeAll()
        lock.unlock()

        for (sessionName, state) in all {
            teardown(state: state, sessionName: sessionName)
        }
    }

    private func cleanupStream(sessionName: String) {
        lock.lock()
        guard let state = activeStreams.removeValue(forKey: sessionName) else {
            lock.unlock()
            return
        }
        lock.unlock()

        state.fileHandle.readabilityHandler = nil
        state.fileHandle.closeFile()
        unlink(state.fifoPath)
    }

    private func teardown(state: StreamState, sessionName: String) {
        state.fileHandle.readabilityHandler = nil
        state.fileHandle.closeFile()
        TmuxService.shared.pipePaneStop(session: sessionName)
        unlink(state.fifoPath)
    }
}
