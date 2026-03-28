import Darwin
import Foundation

final class TmuxPipeTerminalBackend: @unchecked Sendable {
    let sessionName: String
    let paneID: String

    var onData: ((ArraySlice<UInt8>) -> Void)?
    var onExit: ((Int32?) -> Void)?

    var isRunning: Bool {
        stateQueue.sync { isStarted && !isStopped }
    }

    private let stateQueue = DispatchQueue(label: "com.xatlas.tmux-pipe-backend")
    private var fifoPath: String
    private var fileHandle: FileHandle?
    private var isStarted = false
    private var isStopped = false

    init(sessionName: String, paneID: String) {
        self.sessionName = sessionName
        self.paneID = paneID
        self.fifoPath = "/tmp/xatlas_terminal_\(sessionName)_\(UUID().uuidString)"
    }

    @discardableResult
    func start(size: TerminalStreamSize) -> Bool {
        let shouldStart = stateQueue.sync { () -> Bool in
            guard !isStarted else { return false }
            isStarted = true
            isStopped = false
            return true
        }
        guard shouldStart else { return true }

        let startupQueue = DispatchQueue.global(qos: .userInitiated)
        startupQueue.async { [weak self] in
            self?.bootstrapStream()
        }
        return true
    }

    func stop() {
        stateQueue.async { [weak self] in
            self?.shutdown(notifyExit: false)
        }
    }

    func sendInput(_ data: ArraySlice<UInt8>) {
        let bytes = Array(data)
        guard !bytes.isEmpty else { return }

        DispatchQueue.global(qos: .userInitiated).async {
            _ = TmuxService.shared.sendHexInput(toPane: self.paneID, bytes: bytes)
        }
    }

    private func bootstrapStream() {
        unlink(fifoPath)

        guard mkfifo(fifoPath, 0o600) == 0 else {
            shutdown(notifyExit: true)
            return
        }

        guard TmuxService.shared.pipePaneStart(session: sessionName, target: fifoPath) else {
            unlink(fifoPath)
            shutdown(notifyExit: true)
            return
        }

        guard let handle = FileHandle(forReadingAtPath: fifoPath) else {
            TmuxService.shared.pipePaneStop(session: sessionName)
            unlink(fifoPath)
            shutdown(notifyExit: true)
            return
        }

        stateQueue.sync {
            guard !isStopped else { return }
            fileHandle = handle
        }

        handle.readabilityHandler = { [weak self] readableHandle in
            let data = readableHandle.availableData
            guard let self else { return }
            guard !data.isEmpty else {
                self.stateQueue.async {
                    self.shutdown(notifyExit: true)
                }
                return
            }
            DispatchQueue.main.async { [onData] in
                onData?(ArraySlice(data))
            }
        }
    }

    private func shutdown(notifyExit: Bool) {
        if isStopped { return }
        isStopped = true
        isStarted = false

        fileHandle?.readabilityHandler = nil
        try? fileHandle?.close()
        fileHandle = nil

        TmuxService.shared.pipePaneStop(session: sessionName)
        unlink(fifoPath)

        if notifyExit {
            DispatchQueue.main.async { [onExit] in
                onExit?(nil)
            }
        }
    }
}

struct TerminalStreamSize {
    let cols: Int
    let rows: Int
}
