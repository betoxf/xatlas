import SwiftUI

@main
struct XatlasApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var updateService = AppUpdateService.shared

    var body: some Scene {
        // Window is created manually in AppDelegate for custom corner radius
        Settings {
            AppSettingsView(state: AppState.shared)
        }
        .commands {
            CommandGroup(after: .appInfo) {
                Button(updateService.menuActionTitle) {
                    updateService.performPrimaryAction(interactive: true)
                }
                .disabled(updateService.isBusy)
            }
        }
    }
}
