import Foundation

struct Project: Identifiable, Codable, Equatable, Hashable {
    let id: UUID
    var name: String
    var path: String
    var createdAt: Date

    init(name: String, path: String) {
        self.id = UUID()
        self.name = name
        self.path = path
        self.createdAt = .now
    }
}
