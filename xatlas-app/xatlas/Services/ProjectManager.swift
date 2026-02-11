import Foundation

final class ProjectManager {
    nonisolated(unsafe) static let shared = ProjectManager()

    private let supportDir: URL = {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("xatlas", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private var projectsFile: URL { supportDir.appendingPathComponent("projects.json") }

    func loadProjects() -> [Project] {
        guard let data = try? Data(contentsOf: projectsFile),
              let projects = try? JSONDecoder().decode([Project].self, from: data) else {
            return []
        }
        return projects
    }

    func saveProjects(_ projects: [Project]) {
        guard let data = try? JSONEncoder().encode(projects) else { return }
        try? data.write(to: projectsFile)
    }
}
