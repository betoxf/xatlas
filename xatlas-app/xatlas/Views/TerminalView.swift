import AppKit
import SwiftUI
import SwiftTerm

struct StyledTerminalView: View {
    let sessionID: String
    @Bindable var appState: AppState
    var focusToken: Int = 0
    @State private var session: TerminalSession?

    var body: some View {
        Group {
            if let session {
                VStack(spacing: 0) {
                    header(for: session)
                    NativeTmuxTerminalView(sessionID: sessionID, focusToken: focusToken)
                        .id(sessionID)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
                .xatlasSectionSurface(
                    radius: XatlasLayout.sectionCornerRadius,
                    fill: .white.opacity(0.4),
                    stroke: .white.opacity(0.34)
                )
                .padding(XatlasLayout.contentInset)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "terminal")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("Terminal session unavailable")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear(perform: refreshSession)
        .onChange(of: sessionID) { _, _ in
            refreshSession()
        }
        .onReceive(NotificationCenter.default.publisher(for: .xatlasTerminalSessionDidChange)) { note in
            guard let changed = note.userInfo?["session"] as? TerminalSession,
                  changed.id == sessionID else { return }
            session = changed
        }
    }

    @ViewBuilder
    private func header(for session: TerminalSession) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.primary.opacity(0.3))

            VStack(alignment: .leading, spacing: 2) {
                Text(session.displayTitle)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary.opacity(0.72))
                    .lineLimit(1)

                Text(session.displayDirectory)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.38))
                    .lineLimit(1)
            }

            Spacer()

            Text(statusLabel(for: session))
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(statusColor(for: session))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    Capsule().fill(statusColor(for: session).opacity(0.12))
                )
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(XatlasSurface.divider)
                .frame(height: 1)
                .padding(.horizontal, 12)
        }
    }

    private func activityColor(for state: TerminalActivityState) -> SwiftUI.Color {
        switch state {
        case .idle: return .blue.opacity(0.8)
        case .running: return .green.opacity(0.8)
        case .detached: return .orange.opacity(0.8)
        case .exited: return .secondary
        case .error: return .red.opacity(0.8)
        }
    }

    private func statusColor(for session: TerminalSession) -> SwiftUI.Color {
        session.requiresAttention ? .red.opacity(0.82) : activityColor(for: session.activityState)
    }

    private func statusLabel(for session: TerminalSession) -> String {
        session.requiresAttention ? "1" : session.activityState.label
    }

    private func refreshSession() {
        session = TerminalService.shared.session(id: sessionID)
    }
}

private struct NativeTmuxTerminalView: NSViewRepresentable {
    let sessionID: String
    let focusToken: Int

    func makeCoordinator() -> Coordinator {
        Coordinator(sessionID: sessionID)
    }

    func makeNSView(context: Context) -> ManagedTerminalView {
        let terminal = ManagedTerminalView(frame: .zero)
        configure(terminal)
        terminal.terminalDelegate = context.coordinator
        terminal.inputObserver = { [weak coordinator = context.coordinator] text in
            coordinator?.captureInput(text)
        }
        terminal.inputHandler = { [weak coordinator = context.coordinator] data in
            coordinator?.sendInput(data)
        }
        terminal.layoutObserver = { [weak coordinator = context.coordinator, weak terminal] in
            guard let coordinator, let terminal else { return }
            coordinator.attachIfNeeded(terminal)
        }
        context.coordinator.attachIfNeeded(terminal)
        return terminal
    }

    func updateNSView(_ terminal: ManagedTerminalView, context: Context) {
        configure(terminal)
        context.coordinator.prepareForSessionChange(to: sessionID, in: terminal)
        context.coordinator.attachIfNeeded(terminal)
        context.coordinator.focusIfNeeded(token: focusToken, in: terminal)
    }

    static func dismantleNSView(_ terminal: ManagedTerminalView, coordinator: Coordinator) {
        coordinator.detachCurrentSession(from: terminal)
        terminal.terminalDelegate = nil
        terminal.inputObserver = nil
        terminal.inputHandler = nil
        terminal.layoutObserver = nil
    }

    private func configure(_ terminal: ManagedTerminalView) {
        terminal.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        terminal.nativeForegroundColor = NSColor(white: 0.14, alpha: 1.0)
        terminal.nativeBackgroundColor = .clear
        terminal.caretColor = NSColor(calibratedRed: 0.17, green: 0.43, blue: 0.89, alpha: 1.0)
        terminal.terminal.changeHistorySize(10_000)

        func c(_ r: UInt16, _ g: UInt16, _ b: UInt16) -> SwiftTerm.Color {
            SwiftTerm.Color(red: r * 257, green: g * 257, blue: b * 257)
        }

        let palette: [SwiftTerm.Color] = [
            c(0x36, 0x39, 0x46), c(0xd8, 0x4f, 0x4f), c(0x2f, 0x8f, 0x57), c(0xb4, 0x83, 0x1f),
            c(0x2e, 0x67, 0xd1), c(0x9c, 0x51, 0xc6), c(0x1f, 0x88, 0x8a), c(0x8b, 0x90, 0xa0),
            c(0x57, 0x5d, 0x70), c(0xeb, 0x66, 0x66), c(0x44, 0xa9, 0x6a), c(0xcf, 0xa4, 0x38),
            c(0x4b, 0x86, 0xec), c(0xb8, 0x71, 0xe2), c(0x34, 0xa6, 0xa9), c(0x1e, 0x22, 0x2d),
        ]
        terminal.installColors(palette)
    }


    final class Coordinator: NSObject, TerminalViewDelegate {
        private static let minimumCols = 20
        private static let minimumRows = 6

        var sessionID: String
        private var attachedSessionID: String?
        private var attachedSessionName: String?
        private var attachedPaneID: String?
        private var streamSubscriptionID: UUID?
        private var attachmentInFlight = false
        private var inputBuffer = ""
        private var discardingEscapeSequence = false
        private var lastFocusToken: Int?

        init(sessionID: String) {
            self.sessionID = sessionID
        }

        func prepareForSessionChange(to newSessionID: String, in terminal: ManagedTerminalView) {
            guard sessionID != newSessionID else { return }
            sessionID = newSessionID
            detachCurrentSession(from: terminal)
        }

        func detachCurrentSession(from terminal: ManagedTerminalView) {
            if let streamSubscriptionID, let attachedSessionID {
                TerminalStreamService.shared.unsubscribe(sessionID: attachedSessionID, subscriberID: streamSubscriptionID)
            }
            streamSubscriptionID = nil

            MainActor.assumeIsolated {
                terminal.terminal.resetToInitialState()
            }

            attachedSessionID = nil
            attachedSessionName = nil
            attachedPaneID = nil
            attachmentInFlight = false
            inputBuffer = ""
            discardingEscapeSequence = false
        }

        func attachIfNeeded(_ terminal: ManagedTerminalView) {
            guard let session = TerminalService.shared.session(id: sessionID) else { return }
            let sessionName = session.tmuxSessionName
            let workingDirectory = session.currentDirectory ?? session.workingDirectory
            let title = session.displayTitle
            guard !attachmentInFlight else { return }
            guard hasUsableGrid(terminal) else { return }
            if attachedSessionName == sessionName, streamSubscriptionID != nil {
                return
            }
            attachmentInFlight = true

            DispatchQueue.global(qos: .userInitiated).async { [weak self, weak terminal] in
                guard let self else { return }

                let didEnsure = TmuxService.shared.ensureSession(
                    name: sessionName,
                    cwd: workingDirectory,
                    title: title
                )
                guard didEnsure else {
                    DispatchQueue.main.async {
                        guard self.sessionID == session.id else { return }
                        TerminalService.shared.updateActivityState(.error, for: self.sessionID)
                        self.attachmentInFlight = false
                    }
                    return
                }

                let paneID = TmuxService.shared.paneIdentifier(for: sessionName)

                DispatchQueue.main.async {
                    guard let terminal else {
                        self.attachmentInFlight = false
                        return
                    }
                    guard self.sessionID == session.id else {
                        self.attachmentInFlight = false
                        return
                    }
                    guard let paneID else {
                        TerminalService.shared.updateActivityState(.error, for: self.sessionID)
                        self.attachmentInFlight = false
                        return
                    }

                    self.attachedSessionID = self.sessionID
                    self.attachedSessionName = sessionName
                    self.attachedPaneID = paneID
                    self.inputBuffer = ""
                    self.discardingEscapeSequence = false

                    let subscriptionID = TerminalStreamService.shared.subscribe(
                        sessionID: self.sessionID,
                        sessionName: sessionName,
                        paneID: paneID,
                        onBootstrap: { [weak terminal] bytes in
                            guard let terminal else { return }
                            terminal.terminal.resetToInitialState()
                            terminal.feed(byteArray: bytes)
                        },
                        onData: { [weak terminal] bytes in
                            guard let terminal else { return }
                            terminal.feed(byteArray: bytes)
                        },
                        onExit: { [weak self] _ in
                            self?.handleBackendExit()
                        }
                    )

                    self.streamSubscriptionID = subscriptionID
                    self.attachmentInFlight = false
                    TerminalService.shared.handleAttached(sessionID: self.sessionID)
                }
            }
        }

        private func hasUsableGrid(_ terminal: ManagedTerminalView) -> Bool {
            MainActor.assumeIsolated {
                terminal.terminal.cols >= Self.minimumCols && terminal.terminal.rows >= Self.minimumRows
            }
        }

        func captureInput(_ text: String) {
            for scalar in text.unicodeScalars {
                if discardingEscapeSequence {
                    if scalar == "~" || CharacterSet.letters.contains(scalar) {
                        discardingEscapeSequence = false
                    }
                    continue
                }

                switch scalar {
                case "\u{1B}":
                    discardingEscapeSequence = true
                case "\r", "\n":
                    let command = inputBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !command.isEmpty {
                        TerminalService.shared.recordCommand(command, for: sessionID)
                    }
                    inputBuffer = ""
                case "\u{08}", "\u{7F}":
                    if !inputBuffer.isEmpty {
                        inputBuffer.removeLast()
                    }
                default:
                    guard !CharacterSet.controlCharacters.contains(scalar) else { continue }
                    inputBuffer.unicodeScalars.append(scalar)
                }
            }
        }

        func sendInput(_ data: ArraySlice<UInt8>) {
            guard let attachedPaneID else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                _ = TmuxService.shared.sendHexInput(toPane: attachedPaneID, bytes: Array(data))
            }
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            if let text = String(bytes: data, encoding: .utf8) {
                captureInput(text)
            }
            sendInput(data)
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            guard let terminal = source as? ManagedTerminalView else { return }
            guard newCols >= Self.minimumCols, newRows >= Self.minimumRows else { return }
            attachIfNeeded(terminal)
        }

        func setTerminalTitle(source: TerminalView, title: String) {
            TerminalService.shared.syncFromTmux(for: sessionID)
        }

        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
            TerminalService.shared.updateCurrentDirectory(directory, for: sessionID)
        }

        func requestOpenLink(source: TerminalView, link: String, params: [String : String]) {
            guard let url = URL(string: link) else { return }
            NSWorkspace.shared.open(url)
        }

        func scrolled(source: TerminalView, position: Double) {
        }

        func bell(source: TerminalView) {
        }

        func clipboardCopy(source: TerminalView, content: Data) {
            guard let text = String(data: content, encoding: .utf8) else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.writeObjects([text as NSString])
        }

        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {
        }

        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {
        }

        private func handleBackendExit() {
            let exitingSessionID = attachedSessionID ?? sessionID
            TerminalService.shared.handleProcessTerminated(sessionID: exitingSessionID)
            attachedSessionID = nil
            attachedSessionName = nil
            attachedPaneID = nil
            streamSubscriptionID = nil
            attachmentInFlight = false
        }

        func focusIfNeeded(token: Int, in terminal: ManagedTerminalView) {
            guard lastFocusToken != token else { return }
            lastFocusToken = token
            DispatchQueue.main.async {
                _ = terminal.window?.makeFirstResponder(terminal)
                _ = terminal.becomeFirstResponder()
            }
        }
    }
}

private final class ManagedTerminalView: TerminalView {
    var inputObserver: ((String) -> Void)?
    var inputHandler: ((ArraySlice<UInt8>) -> Void)?
    var layoutObserver: (() -> Void)?

    // Prevent the host window's background-drag behavior from stealing text selection.
    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        registerForDraggedTypes([.fileURL, .URL, .tiff, .png])
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layoutObserver?()
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedShellFragments(from: sender.draggingPasteboard).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let fragments = droppedShellFragments(from: sender.draggingPasteboard)
        guard !fragments.isEmpty else { return false }
        window?.makeFirstResponder(self)
        insertDroppedText(fragments.joined(separator: " "))
        return true
    }

    private func insertDroppedText(_ text: String) {
        guard !text.isEmpty else { return }
        inputObserver?(text)
        inputHandler?(ArraySlice(text.utf8))
    }

    private func droppedShellFragments(from pasteboard: NSPasteboard) -> [String] {
        if let fileURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !fileURLs.isEmpty {
            return fileURLs.map { $0.path.shellQuotedForTerminal() }
        }

        if let imageURL = writeDroppedImage(from: pasteboard) {
            return [imageURL.path.shellQuotedForTerminal()]
        }

        return []
    }

    private func writeDroppedImage(from pasteboard: NSPasteboard) -> URL? {
        guard let image = NSImage(pasteboard: pasteboard),
              let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let pngData = bitmap.representation(using: .png, properties: [:]) else {
            return nil
        }

        let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("xatlas-drops", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let fileURL = directory.appendingPathComponent("drop-\(UUID().uuidString).png")
        do {
            try pngData.write(to: fileURL, options: .atomic)
            return fileURL
        } catch {
            return nil
        }
    }
}

private extension Data {
    func trimmingTerminalContent() -> Data {
        var copy = self
        while let last = copy.last, last == 0 || last == 10 || last == 13 || last == 32 {
            copy.removeLast()
        }
        return copy
    }
}

private extension String {
    func shellQuotedForTerminal() -> String {
        if isEmpty {
            return "''"
        }
        return "'" + replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}
