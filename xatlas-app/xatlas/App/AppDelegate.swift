import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMainWindow()
        MCPServer.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        MCPServer.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func configureMainWindow() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        guard let window = NSApplication.shared.windows.first else { return }
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = .clear
        window.titleVisibility = .hidden
        window.toolbar = nil
        window.makeKeyAndOrderFront(nil)
    }
}
