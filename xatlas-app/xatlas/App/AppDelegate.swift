import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private enum LaunchMode {
        case normal
        case backgroundWindow
        case minimizedWindow
        case headless
    }

    var xatlasWindow: NSWindow?
    var keepAliveWindow: NSWindow?
    var keyMonitor: Any?
    private lazy var launchMode: LaunchMode = {
        let environment = ProcessInfo.processInfo.environment
        let arguments = CommandLine.arguments

        if environment["XATLAS_HEADLESS"] == "1" || arguments.contains("--headless") {
            return .headless
        }

        let mode = environment["XATLAS_LAUNCH_MODE"]?.lowercased()
        if mode == "background" || arguments.contains("--background-window") {
            return .backgroundWindow
        }

        if mode == "minimized" || arguments.contains("--minimized-window") {
            return .minimizedWindow
        }

        return .normal
    }()

    private var isHeadless: Bool {
        launchMode == .headless
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(isHeadless ? .accessory : .regular)
        MCPServer.shared.start()
        if AppPreferences.shared.remoteAccessEnabled {
            StreamingServer.shared.start()
        }

        if isHeadless {
            installHeadlessKeepAliveWindow()
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
        self.xatlasWindow = window

        installKeyMonitor()
        presentMainWindow(window)
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
        }
        StreamingServer.shared.stop()
        MCPServer.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !isHeadless
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard launchMode == .normal else { return }
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

    @MainActor
    private func installHeadlessKeepAliveWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: -10_000, y: -10_000, width: 1, height: 1),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.hasShadow = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.makeKeyAndOrderFront(nil)
        keepAliveWindow = window
    }

    @MainActor
    private func presentMainWindow(_ window: NSWindow) {
        switch launchMode {
        case .normal:
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
        case .backgroundWindow:
            window.orderFrontRegardless()
        case .minimizedWindow:
            window.orderFrontRegardless()
            window.miniaturize(nil)
        case .headless:
            break
        }
    }
}
