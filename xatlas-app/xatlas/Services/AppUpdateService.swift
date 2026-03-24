import AppKit
import Foundation

@MainActor
@Observable
final class AppUpdateService {
    static let shared = AppUpdateService()

    enum State: Equatable {
        case idle
        case checking
        case upToDate(branch: String, commit: String)
        case updateAvailable(branch: String, currentCommit: String, remoteCommit: String)
        case updating
        case unavailable(String)
        case blocked(String)
        case failed(String)
    }

    var state: State = .idle

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
    }

    var actionTitle: String {
        switch state {
        case .updateAvailable:
            return "Install Update & Restart"
        case .checking:
            return "Checking…"
        case .updating:
            return "Updating…"
        default:
            return "Check for Updates"
        }
    }

    var menuActionTitle: String {
        switch state {
        case .updateAvailable:
            return "Install Update and Restart"
        case .checking:
            return "Checking for Updates…"
        case .updating:
            return "Updating xatlas…"
        default:
            return "Check for Updates…"
        }
    }

    var statusSummary: String {
        switch state {
        case .idle:
            return "Pull the latest commit for this checkout, rebuild xatlas, and relaunch."
        case .checking:
            return "Checking the current branch for a newer commit."
        case .upToDate(let branch, let commit):
            return "Up to date on \(branch) at \(commit)."
        case .updateAvailable(let branch, let currentCommit, let remoteCommit):
            return "Update available on \(branch): \(currentCommit) -> \(remoteCommit)."
        case .updating:
            return "Pulling, rebuilding, and relaunching xatlas."
        case .unavailable(let message), .blocked(let message), .failed(let message):
            return message
        }
    }

    var isBusy: Bool {
        switch state {
        case .checking, .updating:
            return true
        default:
            return false
        }
    }

    func performPrimaryAction(interactive: Bool = true) {
        switch state {
        case .updateAvailable:
            installUpdateAndRestart(interactive: interactive)
        default:
            checkForUpdates(interactive: interactive)
        }
    }

    func checkForUpdates(interactive: Bool = false) {
        guard !isBusy else { return }
        state = .checking

        DispatchQueue.global(qos: .userInitiated).async {
            let result = Self.inspectRepositoryState()
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.applyInspectionResult(result, interactive: interactive)
            }
        }
    }

    func installUpdateAndRestart(interactive: Bool = true) {
        guard !isBusy else { return }
        state = .updating

        DispatchQueue.global(qos: .userInitiated).async {
            let result = Self.installAvailableUpdate()
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.finishInstall(result, interactive: interactive)
            }
        }
    }

    private func applyInspectionResult(_ result: InspectionResult, interactive: Bool) {
        switch result {
        case .upToDate(let branch, let commit):
            state = .upToDate(branch: branch, commit: commit)
            if interactive {
                _ = presentAlert(
                    title: "xatlas is up to date",
                    message: "Current branch: \(branch)\nCommit: \(commit)"
                )
            }
        case .updateAvailable(let branch, let currentCommit, let remoteCommit):
            state = .updateAvailable(
                branch: branch,
                currentCommit: currentCommit,
                remoteCommit: remoteCommit
            )
            if interactive {
                let response = presentAlert(
                    title: "Update available",
                    message: "Branch: \(branch)\nCurrent: \(currentCommit)\nLatest: \(remoteCommit)\n\nInstall the update, rebuild, and restart xatlas now?",
                    buttons: ["Install and Restart", "Later"]
                )
                if response == .alertFirstButtonReturn {
                    installUpdateAndRestart(interactive: true)
                }
            }
        case .unavailable(let message):
            state = .unavailable(message)
            if interactive {
                _ = presentAlert(title: "Updates unavailable", message: message)
            }
        case .blocked(let message):
            state = .blocked(message)
            if interactive {
                _ = presentAlert(title: "Update blocked", message: message)
            }
        case .failed(let message):
            state = .failed(message)
            if interactive {
                _ = presentAlert(title: "Update check failed", message: message)
            }
        }
    }

    private func finishInstall(_ result: InstallResult, interactive: Bool) {
        switch result {
        case .success:
            state = .updating
            AppState.shared.showToast(
                title: "Updating xatlas",
                message: "The app is rebuilding and will relaunch.",
                style: .success
            )
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                NSApp.terminate(nil)
            }
        case .blocked(let message):
            state = .blocked(message)
            if interactive {
                _ = presentAlert(title: "Update blocked", message: message)
            }
        case .failed(let message):
            state = .failed(message)
            if interactive {
                _ = presentAlert(title: "Update failed", message: message)
            }
        case .unavailable(let message):
            state = .unavailable(message)
            if interactive {
                _ = presentAlert(title: "Updates unavailable", message: message)
            }
        }
    }

    private func presentAlert(
        title: String,
        message: String,
        buttons: [String] = ["OK"]
    ) -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = title
        alert.informativeText = message
        buttons.forEach { title in
            _ = alert.addButton(withTitle: title)
        }
        return alert.runModal()
    }

    private struct RepoContext {
        let repoRoot: URL
        let launchScript: URL
        let branch: String
        let localCommit: String
    }

    private enum InspectionResult {
        case upToDate(branch: String, commit: String)
        case updateAvailable(branch: String, currentCommit: String, remoteCommit: String)
        case unavailable(String)
        case blocked(String)
        case failed(String)
    }

    private enum InstallResult {
        case success
        case unavailable(String)
        case blocked(String)
        case failed(String)
    }

    nonisolated private static func inspectRepositoryState() -> InspectionResult {
        do {
            let context = try resolveRepoContext()
            _ = try run(["/usr/bin/env", "git", "-C", context.repoRoot.path, "fetch", "--quiet", "origin", context.branch])

            let remoteCommit = try trimOutput(
                run(["/usr/bin/env", "git", "-C", context.repoRoot.path, "rev-parse", "origin/\(context.branch)"])
            )
            let localShort = String(context.localCommit.prefix(7))
            let remoteShort = String(remoteCommit.prefix(7))

            if remoteCommit == context.localCommit {
                return .upToDate(branch: context.branch, commit: localShort)
            }
            return .updateAvailable(
                branch: context.branch,
                currentCommit: localShort,
                remoteCommit: remoteShort
            )
        } catch let error as UpdateError {
            switch error {
            case .blocked(let message):
                return .blocked(message)
            case .unavailable(let message):
                return .unavailable(message)
            case .failed(let message):
                return .failed(message)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    nonisolated private static func installAvailableUpdate() -> InstallResult {
        do {
            let context = try resolveRepoContext()
            let statusOutput = try run(["/usr/bin/env", "git", "-C", context.repoRoot.path, "status", "--short"])
            let blockingPaths = parseBlockingPaths(from: statusOutput)
            guard blockingPaths.isEmpty else {
                throw UpdateError.blocked(
                    "Automatic update is blocked by local changes in: \(blockingPaths.joined(separator: ", ")). Commit, stash, or discard them first."
                )
            }

            _ = try run(["/usr/bin/env", "git", "-C", context.repoRoot.path, "pull", "--ff-only", "origin", context.branch])

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [context.launchScript.path]
            process.currentDirectoryURL = context.repoRoot
            try process.run()
            return .success
        } catch let error as UpdateError {
            switch error {
            case .blocked(let message):
                return .blocked(message)
            case .unavailable(let message):
                return .unavailable(message)
            case .failed(let message):
                return .failed(message)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private enum UpdateError: Error {
        case unavailable(String)
        case blocked(String)
        case failed(String)
    }

    nonisolated private static func resolveRepoContext() throws -> RepoContext {
        let fileManager = FileManager.default
        var currentURL = Bundle.main.bundleURL.resolvingSymlinksInPath().deletingLastPathComponent()

        for _ in 0..<8 {
            let gitURL = currentURL.appendingPathComponent(".git", isDirectory: true)
            let launchScript = currentURL
                .appendingPathComponent("xatlas-app", isDirectory: true)
                .appendingPathComponent("scripts", isDirectory: true)
                .appendingPathComponent("launch-app.sh")

            if fileManager.fileExists(atPath: gitURL.path),
               fileManager.fileExists(atPath: launchScript.path) {
                let branch = try trimOutput(
                    run(["/usr/bin/env", "git", "-C", currentURL.path, "rev-parse", "--abbrev-ref", "HEAD"])
                )
                guard branch != "HEAD" else {
                    throw UpdateError.unavailable("Automatic updates require a checked-out branch, not a detached commit.")
                }
                let localCommit = try trimOutput(
                    run(["/usr/bin/env", "git", "-C", currentURL.path, "rev-parse", "HEAD"])
                )
                return RepoContext(
                    repoRoot: currentURL,
                    launchScript: launchScript,
                    branch: branch,
                    localCommit: localCommit
                )
            }

            let parent = currentURL.deletingLastPathComponent()
            guard parent.path != currentURL.path else { break }
            currentURL = parent
        }

        throw UpdateError.unavailable(
            "This build is not running from a local xatlas checkout, so there is no source tree to pull and rebuild."
        )
    }

    nonisolated private static func parseBlockingPaths(from statusOutput: String) -> [String] {
        statusOutput
            .split(separator: "\n")
            .compactMap { line -> String? in
                guard line.count >= 4 else { return nil }
                let path = String(line.dropFirst(3))
                if path.hasPrefix("xatlas-app/.dist/") || path == "vscode-extension" {
                    return nil
                }
                return path
            }
    }

    nonisolated private static func run(_ command: [String]) throws -> String {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()

        process.executableURL = URL(fileURLWithPath: command[0])
        process.arguments = Array(command.dropFirst())
        process.standardOutput = stdout
        process.standardError = stderr

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            throw UpdateError.failed(error.localizedDescription)
        }

        let output = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errorOutput = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

        guard process.terminationStatus == 0 else {
            let trimmedError = errorOutput.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedOutput = output.trimmingCharacters(in: .whitespacesAndNewlines)
            throw UpdateError.failed(trimmedError.isEmpty ? trimmedOutput : trimmedError)
        }

        return output
    }

    nonisolated private static func trimOutput(_ output: String) throws -> String {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw UpdateError.failed("Command returned no output.")
        }
        return trimmed
    }
}
