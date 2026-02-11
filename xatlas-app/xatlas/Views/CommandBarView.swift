import SwiftUI

struct CommandBarView: View {
    @Bindable var state: AppState
    @State private var input = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(.tertiary)

            TextField("Command...", text: $input)
                .textFieldStyle(.plain)
                .font(XatlasFont.mono)
                .focused($isFocused)
                .onSubmit { handleSubmit() }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            Capsule()
                .fill(.white.opacity(0.75))
                .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
                .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
        )
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
        .onChange(of: state.isCommandBarFocused) { _, focused in
            isFocused = focused
        }
    }

    private func handleSubmit() {
        guard !input.isEmpty else { return }
        let command = input
        input = ""

        if command.hasPrefix(":") {
            handleAppCommand(String(command.dropFirst()))
        } else {
            // Send to active terminal
            state.pendingTerminalCommand = command
        }
    }

    private func handleAppCommand(_ cmd: String) {
        let parts = cmd.split(separator: " ", maxSplits: 1)
        guard let action = parts.first else { return }

        switch action {
        case "new":
            let session = TerminalService.shared.createSession(
                projectID: state.selectedProject?.id
            )
            state.openTab(TabItem(id: session.id, title: session.title, kind: .terminal(sessionID: session.id)))
        case "open":
            if let path = parts.dropFirst().first {
                let p = String(path)
                state.openTab(TabItem(id: p, title: URL(fileURLWithPath: p).lastPathComponent, kind: .editor(filePath: p)))
            }
        default:
            break
        }
    }
}
