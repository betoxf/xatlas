import Darwin
import Foundation

struct TmuxSessionDescriptor {
    let name: String
    let title: String?
    let currentDirectory: String?
    let lastActivityAt: Date?
    let createdAt: Date?
}

struct TmuxLaunchCommand {
    let executable: String
    let args: [String]
    let execName: String
}

/// Manages named tmux sessions used by the native terminal tabs and MCP tools.
final class TmuxService {
    nonisolated(unsafe) static let shared = TmuxService()

    static let managedSessionPrefix = "xatlas_"
    private let socketName = "xatlas"
    private let titleOptionName = "@xatlas_title"
    private lazy var executablePath = resolveExecutablePath()
    private let tmuxQueue = DispatchQueue(label: "com.xatlas.tmux-service")

    func isAvailable() -> Bool {
        runTmux(["-V"]).status == 0
    }

    func ensureSession(name: String, cwd: String? = nil, title: String? = nil) -> Bool {
        if sessionExists(name) {
            if let title {
                _ = setSessionTitle(name: name, title: title)
            }
            return true
        }

        var args = ["new-session", "-d", "-s", name]
        if let cwd, !cwd.isEmpty {
            args += ["-c", cwd]
        }

        let created = runTmux(args).status == 0
        guard created else { return false }

        configureSession(name: name)
        if let title {
            _ = setSessionTitle(name: name, title: title)
        }
        return true
    }

    func attachCommand(for sessionName: String) -> TmuxLaunchCommand {
        TmuxLaunchCommand(
            executable: executablePath,
            args: socketArguments + ["attach-session", "-t", sessionName],
            execName: "tmux"
        )
    }

    func sendKeys(session: String, keys: String, pressEnter: Bool = true) -> Bool {
        let typed = runTmux(["send-keys", "-t", session, "-l", keys]).status == 0
        guard typed else { return false }
        if pressEnter {
            return runTmux(["send-keys", "-t", session, "Enter"]).status == 0
        }
        return true
    }

    func capturePane(session: String, lines: Int = 200) -> String? {
        let result = runTmux(["capture-pane", "-t", session, "-p", "-S", "-\(max(20, lines))"])
        guard result.status == 0 else { return nil }
        return result.output?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Capture pane with ANSI escape sequences preserved (for remote terminal rendering)
    func capturePaneWithEscapes(session: String, lines: Int = 500) -> String? {
        let result = runTmux(["capture-pane", "-t", session, "-p", "-e", "-S", "-\(max(20, lines))"])
        guard result.status == 0 else { return nil }
        return result.output
    }

    /// Start piping pane output to a file/FIFO for streaming
    func pipePaneStart(session: String, target: String) -> Bool {
        runTmux(["pipe-pane", "-o", "-t", session, "cat > \(target)"]).status == 0
    }

    /// Stop pipe-pane for a session
    func pipePaneStop(session: String) {
        _ = runTmux(["pipe-pane", "-t", session])
    }

    /// Resize a tmux pane (for iOS client resize events)
    func resizePane(session: String, cols: Int, rows: Int) {
        _ = runTmux(["resize-window", "-t", session, "-x", "\(cols)", "-y", "\(rows)"])
    }

    func listSessions() -> [String] {
        let result = runTmux(["list-sessions", "-F", "#{session_name}"])
        guard result.status == 0, let output = result.output else { return [] }
        return output
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)
    }

    func listManagedSessions() -> [TmuxSessionDescriptor] {
        let timestampMap = sessionTimestamps()

        return listSessions()
            .filter { $0.hasPrefix(Self.managedSessionPrefix) }
            .map { sessionName in
                let timestamps = timestampMap[sessionName]
                return TmuxSessionDescriptor(
                    name: sessionName,
                    title: sessionTitle(for: sessionName),
                    currentDirectory: currentDirectory(for: sessionName),
                    lastActivityAt: timestamps?.lastActivityAt,
                    createdAt: timestamps?.createdAt
                )
            }
    }

    func sessionExists(_ name: String) -> Bool {
        runTmux(["has-session", "-t", name]).status == 0
    }

    func killSession(name: String) -> Bool {
        runTmux(["kill-session", "-t", name]).status == 0
    }

    func currentDirectory(for sessionName: String) -> String? {
        let result = runTmux(["display-message", "-p", "-t", sessionName, "#{pane_current_path}"])
        guard result.status == 0 else { return nil }
        return result.output?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func sessionTitle(for sessionName: String) -> String? {
        let persisted = runTmux(["show-options", "-v", "-t", sessionName, titleOptionName])
        if persisted.status == 0,
           let value = persisted.output?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty {
            return value
        }

        let windowName = runTmux(["display-message", "-p", "-t", sessionName, "#{window_name}"])
        guard windowName.status == 0 else { return nil }
        return windowName.output?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func setSessionTitle(name: String, title: String) -> Bool {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return false }

        let rename = runTmux(["rename-window", "-t", name, cleaned]).status == 0
        let persist = runTmux(["set-option", "-t", name, titleOptionName, cleaned]).status == 0
        return rename || persist
    }

    private func configureSession(name: String) {
        let sessionOptions: [[String]] = [
            ["set-option", "-t", name, "status", "off"],
            ["set-option", "-t", name, "set-clipboard", "off"],
            ["set-option", "-t", name, "destroy-unattached", "off"],
            ["set-option", "-t", name, "mouse", "off"]
        ]
        let windowOptions: [[String]] = [
            ["set-window-option", "-t", name, "history-limit", "50000"],
            ["set-window-option", "-t", name, "remain-on-exit", "on"],
            ["set-window-option", "-t", name, "automatic-rename", "off"],
            ["set-window-option", "-t", name, "allow-rename", "off"]
        ]

        for command in sessionOptions + windowOptions {
            _ = runTmux(command)
        }
    }

    @discardableResult
    private func runTmux(_ args: [String]) -> (status: Int32, output: String?) {
        tmuxQueue.sync {
            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: executablePath)
            process.arguments = socketArguments + args
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                try process.run()
                let terminationStatus = waitForProcessExit(process)
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8)
                return (terminationStatus, output)
            } catch {
                return (-1, nil)
            }
        }
    }

    private func waitForProcessExit(_ process: Process) -> Int32 {
        var status: Int32 = 0
        let pid = process.processIdentifier

        while true {
            let result = waitpid(pid, &status, 0)
            if result == pid { break }
            if result == -1 && errno == EINTR { continue }
            return -1
        }

        if didExit(status) {
            return exitStatus(status)
        }

        if didReceiveSignal(status) {
            return -terminatingSignal(status)
        }

        return -1
    }

    private func didExit(_ status: Int32) -> Bool {
        (status & 0x7f) == 0
    }

    private func exitStatus(_ status: Int32) -> Int32 {
        (status >> 8) & 0xff
    }

    private func didReceiveSignal(_ status: Int32) -> Bool {
        let signal = terminatingSignal(status)
        return signal != 0 && signal != 0x7f
    }

    private func terminatingSignal(_ status: Int32) -> Int32 {
        status & 0x7f
    }

    private func resolveExecutablePath() -> String {
        let fileManager = FileManager.default
        let pathEntries = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)

        let candidates = pathEntries + [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ]

        for directory in candidates {
            let candidate = URL(fileURLWithPath: directory)
                .appendingPathComponent("tmux")
                .path
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }

        return "/usr/bin/tmux"
    }

    private var socketArguments: [String] {
        ["-L", socketName]
    }

    private func sessionTimestamps() -> [String: (lastActivityAt: Date?, createdAt: Date?)] {
        let result = runTmux(["list-sessions", "-F", "#S\t#{session_activity}\t#{session_created}"])
        guard result.status == 0, let output = result.output else { return [:] }

        var timestamps: [String: (lastActivityAt: Date?, createdAt: Date?)] = [:]
        for line in output.split(separator: "\n", omittingEmptySubsequences: true) {
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard let name = parts.first, !name.isEmpty else { continue }
            let lastActivity = parts.count > 1 ? Date(timeIntervalSince1970: TimeInterval(parts[1]) ?? 0) : nil
            let createdAt = parts.count > 2 ? Date(timeIntervalSince1970: TimeInterval(parts[2]) ?? 0) : nil
            timestamps[name] = (
                lastActivityAt: normalizeTimestamp(lastActivity),
                createdAt: normalizeTimestamp(createdAt)
            )
        }
        return timestamps
    }

    func normalizeManagedSessions() {
        for sessionName in listSessions().filter({ $0.hasPrefix(Self.managedSessionPrefix) }) {
            configureSession(name: sessionName)
        }
    }

    private func normalizeTimestamp(_ date: Date?) -> Date? {
        guard let date, date.timeIntervalSince1970 > 0 else { return nil }
        return date
    }
}
