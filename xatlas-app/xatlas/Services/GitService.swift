import Foundation

struct GitStatus {
    let branch: String
    let changes: [GitChange]
    let isRepo: Bool
}

struct GitChange: Identifiable {
    let id: String
    let status: ChangeType
    let file: String

    enum ChangeType: String {
        case modified = "M"
        case added = "A"
        case deleted = "D"
        case untracked = "?"
        case renamed = "R"

        var label: String {
            switch self {
            case .modified: return "M"
            case .added: return "A"
            case .deleted: return "D"
            case .untracked: return "U"
            case .renamed: return "R"
            }
        }
    }

    init(status: ChangeType, file: String) {
        self.id = file
        self.status = status
        self.file = file
    }
}

final class GitService {
    nonisolated(unsafe) static let shared = GitService()

    func status(at path: String) -> GitStatus {
        let isRepo = FileManager.default.fileExists(atPath: path + "/.git")
        guard isRepo else { return GitStatus(branch: "", changes: [], isRepo: false) }

        let branch = run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"])?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "main"

        let statusOutput = run(["git", "-C", path, "status", "--porcelain"]) ?? ""
        let changes = statusOutput
            .split(separator: "\n", omittingEmptySubsequences: true)
            .prefix(50)
            .compactMap { line -> GitChange? in
                let str = String(line)
                guard str.count >= 3 else { return nil }
                let code = String(str.prefix(2)).trimmingCharacters(in: .whitespaces)
                let file = String(str.dropFirst(3))
                let type: GitChange.ChangeType
                switch code {
                case "M", "MM": type = .modified
                case "A": type = .added
                case "D": type = .deleted
                case "??": type = .untracked
                case "R": type = .renamed
                default: type = .modified
                }
                return GitChange(status: type, file: file)
            }

        return GitStatus(branch: branch, changes: changes, isRepo: isRepo)
    }

    func stageAll(at path: String) {
        _ = run(["git", "-C", path, "add", "-A"])
    }

    func commit(at path: String, message: String) {
        _ = run(["git", "-C", path, "commit", "-m", message])
    }

    func push(at path: String) {
        _ = run(["git", "-C", path, "push"])
    }

    func pull(at path: String) {
        _ = run(["git", "-C", path, "pull"])
    }

    func generateCommitMessage(for status: GitStatus) -> String {
        let changes = status.changes
        guard !changes.isEmpty else { return "No changes" }

        let added = changes.filter { $0.status == .added || $0.status == .untracked }
        let modified = changes.filter { $0.status == .modified }
        let deleted = changes.filter { $0.status == .deleted }
        let renamed = changes.filter { $0.status == .renamed }

        // Check if this looks like an initial commit (many untracked files)
        if added.count + changes.filter({ $0.status == .untracked }).count > 5 && modified.isEmpty && deleted.isEmpty {
            return "Initial project setup"
        }

        // Single file change — be specific
        if changes.count == 1 {
            let c = changes[0]
            let name = URL(fileURLWithPath: c.file).lastPathComponent
            switch c.status {
            case .modified: return "Update \(name)"
            case .added, .untracked: return "Add \(name)"
            case .deleted: return "Remove \(name)"
            case .renamed: return "Rename \(name)"
            }
        }

        // Group by file extension to detect patterns
        let extensions = Set(changes.map { (URL(fileURLWithPath: $0.file).pathExtension).lowercased() })
        let dirs = Set(changes.compactMap { file -> String? in
            let parts = file.file.split(separator: "/")
            return parts.count > 1 ? String(parts[0]) : nil
        })

        // Config-only changes
        let configExts: Set<String> = ["json", "yaml", "yml", "toml", "lock", "config", "gitignore"]
        if extensions.isSubset(of: configExts) {
            return "Update project configuration"
        }

        // Build parts
        var parts: [String] = []
        if !modified.isEmpty {
            if modified.count <= 2 {
                let names = modified.map { URL(fileURLWithPath: $0.file).lastPathComponent }
                parts.append("Update \(names.joined(separator: ", "))")
            } else {
                parts.append("Update \(modified.count) files")
            }
        }
        if !added.isEmpty {
            parts.append("add \(added.count) file\(added.count == 1 ? "" : "s")")
        }
        if !deleted.isEmpty {
            parts.append("remove \(deleted.count) file\(deleted.count == 1 ? "" : "s")")
        }
        if !renamed.isEmpty {
            parts.append("rename \(renamed.count) file\(renamed.count == 1 ? "" : "s")")
        }

        if parts.isEmpty { return "Update project" }

        // Capitalize first part, join rest with commas
        var msg = parts[0]
        if parts.count > 1 {
            msg += ", " + parts[1...].joined(separator: ", ")
        }

        // Add scope hint if changes are in a single directory
        if dirs.count == 1, let dir = dirs.first {
            msg += " in \(dir)"
        }

        return msg
    }

    private func run(_ args: [String]) -> String? {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = args
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }
}
