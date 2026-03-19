import SwiftUI
import SwiftTerm

/// UIViewRepresentable wrapping SwiftTerm's iOS TerminalView for remote terminal rendering.
/// Receives raw PTY bytes from the WebSocket and feeds them into SwiftTerm for native rendering.
/// User keystrokes are captured via TerminalViewDelegate and sent back to the desktop.
struct RemoteTerminalView: UIViewRepresentable {
    let streamService: TerminalStreamService

    func makeUIView(context: Context) -> TerminalView {
        let terminal = TerminalView(frame: .zero)
        terminal.terminalDelegate = context.coordinator
        terminal.nativeBackgroundColor = .black
        terminal.nativeForegroundColor = .white

        // Wire up data from WebSocket → SwiftTerm
        context.coordinator.terminalView = terminal
        streamService.onData = { bytes in
            terminal.feed(byteArray: ArraySlice(bytes))
        }

        return terminal
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(streamService: streamService)
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
        let streamService: TerminalStreamService
        weak var terminalView: TerminalView?

        init(streamService: TerminalStreamService) {
            self.streamService = streamService
        }

        // MARK: - TerminalViewDelegate

        public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            streamService.sendResize(cols: newCols, rows: newRows)
        }

        public func setTerminalTitle(source: TerminalView, title: String) {}

        public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

        public func send(source: TerminalView, data: ArraySlice<UInt8>) {
            // Forward keystrokes to desktop via WebSocket
            streamService.sendKeys(Array(data))
        }

        public func scrolled(source: TerminalView, position: Double) {}

        public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}

        public func bell(source: TerminalView) {
            // Haptic feedback on bell
            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.impactOccurred()
        }

        public func clipboardCopy(source: TerminalView, content: Data) {
            if let text = String(data: content, encoding: .utf8) {
                UIPasteboard.general.string = text
            }
        }

        public func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

        public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
