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
                .accessibilityLabel("Command Bar")
                .accessibilityIdentifier("xatlas.commandBar")
                .onSubmit { handleSubmit() }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .xatlasSectionSurface(
            radius: XatlasLayout.sectionCornerRadius,
            fill: .white.opacity(0.72),
            stroke: .white.opacity(0.48)
        )
        .padding(.horizontal, XatlasLayout.contentInset)
        .padding(.top, 12)
        .padding(.bottom, XatlasLayout.contentInset)
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
            sendToActiveTerminal(command)
        }
    }

    private func sendToActiveTerminal(_ command: String) {
        if case .terminal(let sessionID) = state.selectedTab?.kind {
            DispatchQueue.main.async {
                _ = TerminalService.shared.sendCommand(command, to: sessionID)
            }
            return
        }

        let tab = state.createTerminalForSelectedProject()
        DispatchQueue.main.async {
            _ = TerminalService.shared.sendCommand(command, to: tab.id)
        }
    }

    private func handleAppCommand(_ cmd: String) {
        let parts = cmd.split(separator: " ", maxSplits: 1)
        guard let action = parts.first else { return }

        switch action {
        case "new":
            _ = state.createTerminalForSelectedProject()
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
