import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Activate app and bring window to front
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.configureMainWindow()
        }

        MCPServer.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        MCPServer.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // Ensure window is key whenever app activates
        NSApplication.shared.windows.first?.makeKeyAndOrderFront(nil)
    }

    private func configureMainWindow() {
        guard let window = NSApplication.shared.windows.first else { return }
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = .clear
        window.titleVisibility = .hidden
        window.toolbar = nil
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
    }
}
