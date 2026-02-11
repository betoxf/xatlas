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
