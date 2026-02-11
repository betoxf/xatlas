import SwiftUI

struct ContentAreaView: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            // Minimal tab strip — only if multiple tabs
            if state.tabs.count > 1 {
                tabBar
            }

            // Content fills everything
            if let tab = state.selectedTab {
                tabContent(tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                emptyState
            }

            // Command bar
            CommandBarView(state: state)
        }
    }

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(state.tabs) { tab in
                    TabButton(
                        tab: tab,
                        isSelected: state.selectedTab?.id == tab.id,
                        onSelect: { state.selectedTab = tab },
                        onClose: { state.closeTab(tab) }
                    )
                }
            }
            .padding(.horizontal, 8)
        }
        .frame(height: 30)
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private func tabContent(_ tab: TabItem) -> some View {
        switch tab.kind {
        case .terminal(let sessionID):
            StyledTerminalView(
                sessionID: sessionID,
                workingDirectory: state.selectedProject?.path
            )
        case .editor(let filePath):
            EditorView(filePath: filePath)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Press ⌘K to open command bar")
                .font(XatlasFont.mono)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct TabButton: View {
    let tab: TabItem
    let isSelected: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: tab.kind.isTerminal ? "terminal" : "doc.text")
                .font(.system(size: 10))

            Text(tab.title)
                .font(XatlasFont.monoSmall)
                .lineLimit(1)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
            }
            .buttonStyle(.plain)
            .opacity(isSelected ? 0.6 : 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(isSelected ? .white.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
    }
}

extension TabItem.TabKind {
    var isTerminal: Bool {
        if case .terminal = self { return true }
        return false
    }
}
