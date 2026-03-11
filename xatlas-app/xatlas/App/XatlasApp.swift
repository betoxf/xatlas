import SwiftUI

@main
struct XatlasApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // Window is created manually in AppDelegate for custom corner radius
        Settings {
            AppSettingsView()
        }
    }
}
