import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    var xatlasWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)

        // Create a custom borderless window for full corner control
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.minSize = NSSize(width: 800, height: 500)
        window.center()

        // Host the SwiftUI content
        let hostingView = NSHostingView(rootView: MainView().frame(minWidth: 800, minHeight: 500))
        hostingView.wantsLayer = true
        hostingView.layer?.cornerRadius = 24
        hostingView.layer?.masksToBounds = true

        window.contentView = hostingView
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()

        self.xatlasWindow = window

        NSApplication.shared.activate(ignoringOtherApps: true)
        MCPServer.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        MCPServer.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        xatlasWindow?.makeKeyAndOrderFront(nil)
    }
}
