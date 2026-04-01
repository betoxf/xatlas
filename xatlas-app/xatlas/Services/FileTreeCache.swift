import Foundation

final class FileTreeCache: @unchecked Sendable {
    static let shared = FileTreeCache()

    private let fileManager = FileManager.default
    private let workerQueue = DispatchQueue(
        label: "xatlas.file-tree-cache.worker",
        qos: .userInitiated,
        attributes: .concurrent
    )
    private let stateQueue = DispatchQueue(label: "xatlas.file-tree-cache.state")
    private var cache: [String: [FileEntry]] = [:]

    private init() {}

    func cachedEntries(at path: String) -> [FileEntry]? {
        stateQueue.sync { cache[path] }
    }

    func preload(rootPath: String, limit: Int = 50) {
        guard cachedEntries(at: rootPath) == nil else { return }
        loadEntries(at: rootPath, limit: limit) { _ in }
    }

    func loadEntries(
        at rootPath: String,
        limit: Int = 50,
        forceRefresh: Bool = false,
        completion: @escaping @MainActor ([FileEntry]) -> Void
    ) {
        if !forceRefresh, let cached = cachedEntries(at: rootPath) {
            Task { @MainActor in
                completion(cached)
            }
            return
        }

        workerQueue.async { [weak self] in
            guard let self else { return }
            let entries = self.readEntries(at: rootPath, limit: limit)
            self.stateQueue.async {
                self.cache[rootPath] = entries
                Task { @MainActor in
                    completion(entries)
                }
            }
        }
    }

    private func readEntries(at rootPath: String, limit: Int) -> [FileEntry] {
        let url = URL(fileURLWithPath: rootPath, isDirectory: true)
        let resourceKeys: Set<URLResourceKey> = [.isDirectoryKey]

        guard let items = try? fileManager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: Array(resourceKeys),
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        let entries = items.compactMap { itemURL -> FileEntry? in
            let name = itemURL.lastPathComponent
            guard name != "node_modules", name != ".build" else { return nil }
            let values = try? itemURL.resourceValues(forKeys: resourceKeys)
            return FileEntry(
                name: name,
                path: itemURL.path,
                isDirectory: values?.isDirectory ?? false
            )
        }

        return Array(
            entries
                .sorted { lhs, rhs in
                    if lhs.isDirectory != rhs.isDirectory {
                        return lhs.isDirectory && !rhs.isDirectory
                    }
                    return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                }
                .prefix(limit)
        )
    }
}
