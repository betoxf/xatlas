import AppKit
import Foundation

extension AppState {
    /// Opens (or creates) a text file in an editor tab, materializing
    /// any missing parent directories and seeding the file with
    /// `initialContent` if it doesn't already exist.
    func openTextFile(path: String, initialContent: String? = nil) {
        let fileManager = FileManager.default
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)

        if !fileManager.fileExists(atPath: path), let initialContent {
            fileManager.createFile(atPath: path, contents: initialContent.data(using: .utf8))
        }

        openTab(
            TabItem(
                id: path,
                title: URL(fileURLWithPath: path).lastPathComponent,
                kind: .editor(filePath: path)
            )
        )
    }

    /// Reveals a path in Finder. Optionally creates the path first
    /// (handy for "open the user's ~/.codex/skills folder" actions).
    func revealInFinder(path: String, createIfMissing: Bool = false, isDirectory: Bool = false) {
        let fileManager = FileManager.default
        if createIfMissing {
            if isDirectory {
                try? fileManager.createDirectory(atPath: path, withIntermediateDirectories: true)
            } else {
                let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
                try? fileManager.createDirectory(atPath: directory, withIntermediateDirectories: true)
                if !fileManager.fileExists(atPath: path) {
                    fileManager.createFile(atPath: path, contents: Data())
                }
            }
        }

        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}
