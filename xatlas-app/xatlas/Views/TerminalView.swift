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
        Coordinator()
    }

    func makeNSView(context: Context) -> PersistentTerminalHostView {
        let host = PersistentTerminalHostView(frame: .zero)
        context.coordinator.update(host: host, sessionID: sessionID, focusToken: focusToken)
        return host
    }

    func updateNSView(_ host: PersistentTerminalHostView, context: Context) {
        context.coordinator.update(host: host, sessionID: sessionID, focusToken: focusToken)
    }

    static func dismantleNSView(_ host: PersistentTerminalHostView, coordinator: Coordinator) {
        coordinator.dismantle(host: host)
    }

    final class Coordinator {
        @MainActor
        func update(host: PersistentTerminalHostView, sessionID: String, focusToken: Int) {
            guard let surface = TerminalSurfaceRegistry.shared.surface(for: sessionID) else {
                host.unmount()
                return
            }

            host.mount(surface)
            surface.ensureAttached()
            surface.focusIfNeeded(token: focusToken)
        }

        @MainActor
        func dismantle(host: PersistentTerminalHostView) {
            host.unmount()
        }
    }
}

@MainActor
private final class TerminalSurfaceRegistry {
    static let shared = TerminalSurfaceRegistry()

    private var surfaces: [String: TerminalSessionSurface] = [:]
    private var sessionObserver: NSObjectProtocol?

    private init() {
        sessionObserver = NotificationCenter.default.addObserver(
            forName: .xatlasTerminalSessionDidChange,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self,
                  let session = note.userInfo?["session"] as? TerminalSession else { return }
            if TerminalService.shared.session(id: session.id) == nil {
                Task { @MainActor [weak self] in
                    self?.releaseSurface(session.id)
                }
            }
        }
    }

    func surface(for sessionID: String) -> TerminalSessionSurface? {
        guard TerminalService.shared.session(id: sessionID) != nil else {
            releaseSurface(sessionID)
            return nil
        }

        if let surface = surfaces[sessionID] {
            return surface
        }

        let surface = TerminalSessionSurface(sessionID: sessionID)
        surfaces[sessionID] = surface
        return surface
    }

    private func releaseSurface(_ sessionID: String) {
        guard let surface = surfaces.removeValue(forKey: sessionID) else { return }
        surface.releaseResources()
    }
}

@MainActor
private final class TerminalSessionSurface: NSObject, @preconcurrency TerminalViewDelegate, @unchecked Sendable {
    let sessionID: String
    let terminalView: ManagedTerminalView

    private var attachedSessionName: String?
    private var attachedPaneID: String?
    private var streamSubscriptionID: UUID?
    private var attachmentInFlight = false
    private var inputBuffer = ""
    private var discardingEscapeSequence = false
    private var lastFocusToken: Int?
    private var needsResetOnBootstrap = true

    init(sessionID: String) {
        self.sessionID = sessionID
        self.terminalView = ManagedTerminalView(frame: .zero)
        super.init()
        configureIfNeeded(terminalView)
        terminalView.terminalDelegate = self
        terminalView.inputObserver = { [weak self] text in
            self?.captureInput(text)
        }
        terminalView.inputHandler = { [weak self] data in
            self?.sendInput(data)
        }
    }

    func ensureAttached() {
        guard let session = TerminalService.shared.session(id: sessionID) else { return }
        let sessionName = session.tmuxSessionName
        let workingDirectory = session.currentDirectory ?? session.workingDirectory
        let title = session.displayTitle

        guard !attachmentInFlight else { return }
        guard streamSubscriptionID == nil || attachedSessionName != sessionName else { return }
        attachmentInFlight = true

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }

            let didEnsure = TmuxService.shared.ensureSession(
                name: sessionName,
                cwd: workingDirectory,
                title: title
            )
            let paneID = didEnsure ? TmuxService.shared.paneIdentifier(for: sessionName) : nil

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard let currentSession = TerminalService.shared.session(id: self.sessionID),
                      currentSession.tmuxSessionName == sessionName else {
                    self.attachmentInFlight = false
                    return
                }

                guard didEnsure, let paneID else {
                    TerminalService.shared.updateActivityState(.error, for: self.sessionID)
                    self.attachmentInFlight = false
                    return
                }

                self.attachedSessionName = sessionName
                self.attachedPaneID = paneID
                self.inputBuffer = ""
                self.discardingEscapeSequence = false

                self.streamSubscriptionID = TerminalStreamService.shared.subscribe(
                    sessionID: self.sessionID,
                    sessionName: sessionName,
                    onBootstrap: { [weak self] bytes in
                        DispatchQueue.main.async {
                            self?.applyBootstrap(bytes)
                        }
                    },
                    onData: { [weak self] bytes in
                        DispatchQueue.main.async {
                            self?.terminalView.feed(byteArray: bytes)
                        }
                    },
                    onExit: { [weak self] _ in
                        DispatchQueue.main.async {
                            self?.handleBackendExit()
                        }
                    }
                )

                self.attachmentInFlight = false
                TerminalService.shared.handleAttached(sessionID: self.sessionID)
            }
        }
    }

    func releaseResources() {
        if let streamSubscriptionID {
            TerminalStreamService.shared.unsubscribe(sessionID: sessionID, subscriberID: streamSubscriptionID)
        }
        streamSubscriptionID = nil
        attachedSessionName = nil
        attachedPaneID = nil
        attachmentInFlight = false
        inputBuffer = ""
        discardingEscapeSequence = false
        needsResetOnBootstrap = true
        terminalView.removeFromSuperview()
    }

    func focusIfNeeded(token: Int) {
        guard lastFocusToken != token else { return }
        lastFocusToken = token
        DispatchQueue.main.async {
            _ = self.terminalView.window?.makeFirstResponder(self.terminalView)
            _ = self.terminalView.becomeFirstResponder()
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
    }

    func setTerminalTitle(source: TerminalView, title: String) {
        TerminalService.shared.syncFromTmuxAsync(for: sessionID)
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
        TerminalService.shared.handleProcessTerminated(sessionID: sessionID)
        attachedSessionName = nil
        attachedPaneID = nil
        streamSubscriptionID = nil
        attachmentInFlight = false
        needsResetOnBootstrap = true
    }

    private func applyBootstrap(_ bytes: ArraySlice<UInt8>) {
        if needsResetOnBootstrap {
            terminalView.terminal.resetToInitialState()
            needsResetOnBootstrap = false
        }
        terminalView.feed(byteArray: bytes)
    }

    private func configureIfNeeded(_ terminal: ManagedTerminalView) {
        guard !terminal.hasConfiguredAppearance else { return }
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
        terminal.hasConfiguredAppearance = true
    }
}

private final class PersistentTerminalHostView: NSView {
    private weak var mountedSurface: TerminalSessionSurface?

    func mount(_ surface: TerminalSessionSurface) {
        guard mountedSurface !== surface || surface.terminalView.superview !== self else { return }

        subviews.forEach { $0.removeFromSuperview() }
        let terminalView = surface.terminalView
        terminalView.removeFromSuperview()
        terminalView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(terminalView)
        NSLayoutConstraint.activate([
            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalView.topAnchor.constraint(equalTo: topAnchor),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        mountedSurface = surface
    }

    func unmount() {
        mountedSurface?.terminalView.removeFromSuperview()
        mountedSurface = nil
    }
}

private final class ManagedTerminalView: TerminalView {
    var inputObserver: ((String) -> Void)?
    var inputHandler: ((ArraySlice<UInt8>) -> Void)?
    var hasConfiguredAppearance = false

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

private extension String {
    func shellQuotedForTerminal() -> String {
        if isEmpty {
            return "''"
        }
        return "'" + replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}
