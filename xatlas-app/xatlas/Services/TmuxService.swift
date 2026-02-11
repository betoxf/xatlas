import Foundation

/// Manages tmux sessions for headless/MCP-controlled terminals.
/// Mirrors functionality from vscode-extension's tmuxManager.ts.
final class TmuxService {
    nonisolated(unsafe) static let shared = TmuxService()

    func createSession(name: String, command: String? = nil, cwd: String? = nil) -> Bool {
        var args = ["new-session", "-d", "-s", name]
        if let cwd { args += ["-c", cwd] }
        if let command { args.append(command) }
        return runTmux(args)
    }

    func sendKeys(session: String, keys: String) -> Bool {
        runTmux(["send-keys", "-t", session, keys, "Enter"])
    }

    func capturePane(session: String) -> String? {
        let result = runTmuxWithOutput(["capture-pane", "-t", session, "-p"])
        return result
    }

    func listSessions() -> [String] {
        guard let output = runTmuxWithOutput(["list-sessions", "-F", "#{session_name}"]) else { return [] }
        return output.split(separator: "\n").map(String.init)
    }

    func killSession(name: String) -> Bool {
        runTmux(["kill-session", "-t", name])
    }

    @discardableResult
    private func runTmux(_ args: [String]) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["tmux"] + args
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    private func runTmuxWithOutput(_ args: [String]) -> String? {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["tmux"] + args
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }
}
