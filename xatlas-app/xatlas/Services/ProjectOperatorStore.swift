import Foundation

final class ProjectOperatorStore {
    nonisolated(unsafe) static let shared = ProjectOperatorStore()

    private let supportDir: URL = {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("xatlas", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private var statesFile: URL { supportDir.appendingPathComponent("project-operator-states.json") }

    func load() -> [UUID: ProjectOperatorState] {
        guard let data = try? Data(contentsOf: statesFile),
              let states = try? JSONDecoder().decode([ProjectOperatorState].self, from: data) else {
            return [:]
        }
        return Dictionary(uniqueKeysWithValues: states.map { ($0.projectID, $0) })
    }

    func save(_ states: [UUID: ProjectOperatorState]) {
        let values = states.values.sorted { $0.projectID.uuidString < $1.projectID.uuidString }
        guard let data = try? JSONEncoder().encode(values) else { return }
        try? data.write(to: statesFile)
    }
}
