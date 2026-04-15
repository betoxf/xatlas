import Foundation

/// Visual style for transient toast notifications.
enum AppToastStyle: Equatable {
    case neutral
    case success
    case warning
    case error
}

/// One transient notification shown in the bottom-right of the window.
/// Posted via AppState.showToast.
struct AppToast: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String?
    let style: AppToastStyle
}
