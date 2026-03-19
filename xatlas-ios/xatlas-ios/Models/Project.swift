import Foundation

struct Project: Identifiable, Codable, Equatable {
    let id: UUID
    let name: String
    let path: String
}
