import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    var xatlasWindow: NSWindow?
    var keyMonitor: Any?
    private let isHeadless = ProcessInfo.processInfo.environment["XATLAS_HEADLESS"] == "1" || CommandLine.arguments.contains("--headless")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(isHeadless ? .accessory : .regular)

        if isHeadless {
            MCPServer.shared.start()
            return
        }

        // Create a custom borderless window for full corner control
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "xatlas"
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
        installKeyMonitor()
        MCPServer.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
        }
        MCPServer.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !isHeadless
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard !isHeadless else { return }
        xatlasWindow?.makeKeyAndOrderFront(nil)
    }

    private func installKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard flags.contains(.command),
                  let characters = event.charactersIgnoringModifiers,
                  let digit = Int(String(characters.prefix(1))),
                  (1...9).contains(digit) else {
                return event
            }

            let handled = AppState.shared.selectTab(at: digit - 1)
            return handled ? nil : event
        }
    }
}
