import Foundation

struct TerminalSession: Identifiable {
    let id: String
    let title: String
    var projectID: UUID?
    var isActive: Bool = true

    init(title: String = "Terminal", projectID: UUID? = nil) {
        self.id = UUID().uuidString
        self.title = title
        self.projectID = projectID
    }
}
