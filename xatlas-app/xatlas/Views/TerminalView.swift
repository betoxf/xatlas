import SwiftUI
import SwiftTerm

// MARK: - Styled terminal card

struct StyledTerminalView: View {
    let sessionID: String
    var workingDirectory: String?
    @Bindable var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.primary.opacity(0.3))

                Text(displayPath)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.4))
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)

            InteractiveTerminal(workingDirectory: workingDirectory ?? NSHomeDirectory(), appState: appState)
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(8)
    }

    private var displayPath: String {
        guard let path = workingDirectory else { return "~" }
        return path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }
}

// MARK: - Interactive SwiftUI terminal (shell via Process + pipes)

struct InteractiveTerminal: View {
    let workingDirectory: String
    @Bindable var appState: AppState

    @State private var outputLines: [OutputLine] = []
    @State private var currentInput = ""
    @State private var shellProcess: Process?
    @State private var inputPipe: Pipe?
    @State private var isRunning = false
    @FocusState private var isFocused: Bool

    private let textColor = SwiftUI.Color(white: 0.25)
    private let promptColor = SwiftUI.Color.blue.opacity(0.6)
    private let dimColor = SwiftUI.Color(white: 0.45)

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(outputLines.enumerated()), id: \.offset) { i, line in
                        Text(line.attributed)
                            .font(.system(size: 13, design: .monospaced))
                            .textSelection(.enabled)
                            .id(i)
                    }

                    // Input line
                    HStack(spacing: 0) {
                        Text(promptString)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(promptColor)

                        FocusableTextField(
                            text: $currentInput,
                            isFocused: $isFocused,
                            textColor: textColor,
                            onSubmit: executeCommand
                        )
                        .id("input")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            }
            .onChange(of: outputLines.count) { _, _ in
                proxy.scrollTo("input", anchor: .bottom)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .defaultFocus($isFocused, true)
        .onChange(of: appState.pendingTerminalCommand) { _, cmd in
            if let cmd {
                currentInput = cmd
                appState.pendingTerminalCommand = nil
                executeCommand()
            }
        }
    }

    private var promptString: String {
        let dir = workingDirectory.replacingOccurrences(of: NSHomeDirectory(), with: "~")
        let folder = URL(fileURLWithPath: workingDirectory).lastPathComponent
        return "\(folder) ❯ "
    }

    private func executeCommand() {
        let command = currentInput
        currentInput = ""

        // Show the command in output
        outputLines.append(OutputLine(text: "\(promptString)\(command)", kind: .prompt))

        guard !command.isEmpty else { return }

        // Run in background
        Task.detached {
            let process = Process()
            let outPipe = Pipe()
            let errPipe = Pipe()

            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-l", "-c", command]
            process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
            process.standardOutput = outPipe
            process.standardError = errPipe
            process.environment = ProcessInfo.processInfo.environment

            do {
                try process.run()
                process.waitUntilExit()

                let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                let stdout = String(data: outData, encoding: .utf8) ?? ""
                let stderr = String(data: errData, encoding: .utf8) ?? ""

                await MainActor.run {
                    if !stdout.isEmpty {
                        for line in stdout.split(separator: "\n", omittingEmptySubsequences: false) {
                            outputLines.append(OutputLine(text: String(line), kind: .stdout))
                        }
                    }
                    if !stderr.isEmpty {
                        for line in stderr.split(separator: "\n", omittingEmptySubsequences: false) {
                            outputLines.append(OutputLine(text: String(line), kind: .stderr))
                        }
                    }
                }
            } catch {
                await MainActor.run {
                    outputLines.append(OutputLine(text: "Error: \(error.localizedDescription)", kind: .stderr))
                }
            }
        }
    }
}

private struct OutputLine {
    let text: String
    let kind: Kind

    enum Kind { case prompt, stdout, stderr }

    var attributed: AttributedString {
        var str = AttributedString(text)
        switch kind {
        case .prompt:
            str.foregroundColor = .blue.opacity(0.6)
        case .stdout:
            str.foregroundColor = Color(white: 0.25)
        case .stderr:
            str.foregroundColor = .red.opacity(0.7)
        }
        return str
    }
}

// MARK: - NSTextField wrapper that actually takes keyboard focus

struct FocusableTextField: NSViewRepresentable {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    var textColor: SwiftUI.Color
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField()
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        field.textColor = NSColor(white: 0.25, alpha: 1.0)
        field.delegate = context.coordinator
        field.cell?.wraps = false
        field.cell?.isScrollable = true

        // Aggressively grab focus once the window is ready
        context.coordinator.field = field
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            field.window?.makeKeyAndOrderFront(nil)
            field.window?.makeFirstResponder(field)
        }
        return field
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        if field.stringValue != text {
            field.stringValue = text
        }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: FocusableTextField
        weak var field: NSTextField?
        init(_ parent: FocusableTextField) { self.parent = parent }

        func refocus() {
            guard let field else { return }
            field.window?.makeFirstResponder(field)
        }

        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            parent.text = field.stringValue
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                parent.onSubmit()
                // Clear and refocus after submit
                DispatchQueue.main.async { [weak self] in
                    self?.field?.stringValue = ""
                    self?.refocus()
                }
                return true
            }
            return false
        }
    }
}

// MARK: - Real SwiftTerm view (for future swap-in)

struct RealTerminalView: NSViewRepresentable {
    let sessionID: String
    var workingDirectory: String?

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let terminal = LocalProcessTerminalView(frame: .zero)
        terminal.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        terminal.nativeForegroundColor = NSColor(white: 0.12, alpha: 1.0)

        func c(_ r: UInt16, _ g: UInt16, _ b: UInt16) -> SwiftTerm.Color {
            SwiftTerm.Color(red: r * 257, green: g * 257, blue: b * 257)
        }
        let palette: [SwiftTerm.Color] = [
            c(0x3c, 0x3c, 0x43), c(0xc4, 0x35, 0x35), c(0x2e, 0x7d, 0x32), c(0x9e, 0x7c, 0x0c),
            c(0x1e, 0x5a, 0xb3), c(0x8e, 0x3e, 0xb5), c(0x1a, 0x7d, 0x7a), c(0x5c, 0x5c, 0x64),
            c(0x6e, 0x6e, 0x78), c(0xe8, 0x4d, 0x4d), c(0x43, 0xa0, 0x47), c(0xc4, 0x9c, 0x1a),
            c(0x2e, 0x78, 0xd6), c(0xab, 0x55, 0xd6), c(0x25, 0xa0, 0x9c), c(0x1d, 0x1d, 0x1f),
        ]
        terminal.installColors(palette)

        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        terminal.startProcess(executable: shell, args: [], environment: nil, execName: nil)
        return terminal
    }

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {}
}
