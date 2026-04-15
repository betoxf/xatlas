import Foundation

/// Whether the projects section is showing the dashboard grid or the
/// active workspace (sidebar + tabs).
enum ProjectSurfaceMode: String, CaseIterable, Identifiable {
    case workspace
    case dashboard

    var id: String { rawValue }
}

/// What should happen after a project is added — drop the user into its
/// workspace immediately, or keep them on the dashboard grid.
enum ProjectAdditionBehavior {
    case selectInWorkspace
    case stayOnDashboard
}
