import SwiftUI
import SwiftTerm

// MARK: - Design shell (pure SwiftUI, no SwiftTerm rendering yet)

/// The styled terminal card — glass material, rounded, matches sidebar
struct StyledTerminalView: View {
    let sessionID: String
    var workingDirectory: String?

    var body: some View {
        VStack(spacing: 0) {
            // Titlebar
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

            // Terminal content area — placeholder for now
            TerminalPlaceholder()
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
        }
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(8)
    }

    private var displayPath: String {
        guard let path = workingDirectory else { return "~" }
        return path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }
}

/// Pure SwiftUI terminal placeholder — looks like a terminal, no AppKit
private struct TerminalPlaceholder: View {
    @State private var inputText = ""
    @State private var lines: [TerminalLine] = [
        TerminalLine(prompt: true, text: "echo \"Hello from xatlas\""),
        TerminalLine(prompt: false, text: "Hello from xatlas"),
        TerminalLine(prompt: true, text: ""),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 0) {
                        if line.prompt {
                            Text("~ ❯ ")
                                .foregroundStyle(.blue.opacity(0.7))
                        }
                        Text(line.text)
                            .foregroundStyle(.primary.opacity(0.85))
                    }
                    .font(.system(size: 13, design: .monospaced))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .background(.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct TerminalLine {
    let prompt: Bool
    let text: String
}

// MARK: - Real SwiftTerm view (for later use)

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
