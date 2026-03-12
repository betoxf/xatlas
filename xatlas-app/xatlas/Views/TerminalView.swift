import AppKit
import SwiftUI
import SwiftTerm

struct StyledTerminalView: View {
    let sessionID: String
    @Bindable var appState: AppState
    @State private var session: TerminalSession?

    var body: some View {
        Group {
            if let session {
                VStack(spacing: 0) {
                    header(for: session)
                    NativeTmuxTerminalView(sessionID: sessionID)
                        .padding(.horizontal, 6)
                        .padding(.bottom, 6)
                }
                .padding(10)
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
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.white.opacity(0.32))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(.white.opacity(0.22), lineWidth: 1)
                )
        )
        .padding(.horizontal, 4)
        .padding(.top, 6)
        .padding(.bottom, 8)
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

    func makeCoordinator() -> Coordinator {
        Coordinator(sessionID: sessionID)
    }

    func makeNSView(context: Context) -> ManagedLocalProcessTerminalView {
        let terminal = ManagedLocalProcessTerminalView(frame: .zero)
        configure(terminal)
        terminal.processDelegate = context.coordinator
        terminal.inputObserver = { [weak coordinator = context.coordinator] text in
            coordinator?.captureInput(text)
        }
        terminal.layoutObserver = { [weak coordinator = context.coordinator, weak terminal] in
            guard let coordinator, let terminal else { return }
            coordinator.attachIfNeeded(terminal)
        }
        context.coordinator.attachIfNeeded(terminal)
        return terminal
    }

    func updateNSView(_ terminal: ManagedLocalProcessTerminalView, context: Context) {
        configure(terminal)
        context.coordinator.sessionID = sessionID
        context.coordinator.attachIfNeeded(terminal)
    }

    private func configure(_ terminal: ManagedLocalProcessTerminalView) {
        terminal.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        terminal.nativeForegroundColor = NSColor(white: 0.14, alpha: 1.0)
        terminal.nativeBackgroundColor = .clear
        terminal.caretColor = NSColor(calibratedRed: 0.17, green: 0.43, blue: 0.89, alpha: 1.0)

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


    final class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
        private static let minimumCols = 20
        private static let minimumRows = 6

        var sessionID: String
        private var attachedSessionName: String?
        private var inputBuffer = ""
        private var discardingEscapeSequence = false

        init(sessionID: String) {
            self.sessionID = sessionID
        }

        func attachIfNeeded(_ terminal: ManagedLocalProcessTerminalView) {
            guard let session = TerminalService.shared.session(id: sessionID) else { return }
            let sessionName = session.tmuxSessionName
            let isRunning = MainActor.assumeIsolated {
                terminal.process?.running ?? false
            }
            guard attachedSessionName != sessionName || !isRunning else { return }
            guard hasUsableGrid(terminal) else { return }
            guard TerminalService.shared.ensureBackingSession(for: sessionID) else { return }

            attachedSessionName = sessionName
            inputBuffer = ""
            discardingEscapeSequence = false

            let command = TmuxService.shared.attachCommand(for: sessionName)
            MainActor.assumeIsolated {
                terminal.startProcess(
                    executable: command.executable,
                    args: command.args,
                    environment: nil,
                    execName: command.execName,
                    currentDirectory: session.currentDirectory ?? session.workingDirectory
                )
            }
            TerminalService.shared.handleAttached(sessionID: sessionID)
        }

        private func hasUsableGrid(_ terminal: ManagedLocalProcessTerminalView) -> Bool {
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

        func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {
            guard let terminal = source as? ManagedLocalProcessTerminalView else { return }
            attachIfNeeded(terminal)
        }

        func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
            TerminalService.shared.syncFromTmux(for: sessionID)
        }

        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
            TerminalService.shared.updateCurrentDirectory(directory, for: sessionID)
        }

        func processTerminated(source: TerminalView, exitCode: Int32?) {
            TerminalService.shared.handleProcessTerminated(sessionID: sessionID)
            attachedSessionName = nil
        }
    }
}

private final class ManagedLocalProcessTerminalView: LocalProcessTerminalView {
    var inputObserver: ((String) -> Void)?
    var layoutObserver: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layoutObserver?()
    }

    override func send(source: TerminalView, data: ArraySlice<UInt8>) {
        if let text = String(bytes: data, encoding: .utf8) {
            inputObserver?(text)
        }
        super.send(source: source, data: data)
    }
}
