import Foundation

/// The platform/agent that owns a catalog entry's configuration source.
enum CatalogProvider: String {
    case codex
    case claude
    case project

    var label: String { rawValue.capitalized }
}

/// Where a catalog entry is configured: globally for the user, scoped to
/// a specific project, or local-only.
enum CatalogScope: String {
    case user
    case project
    case local

    var label: String { rawValue.capitalized }
}

/// How a catalog entry was discovered: written into a config file, found
/// by scanning a folder, or installed via a plugin marketplace.
enum CatalogOrigin {
    case config
    case folder
    case plugin
}
