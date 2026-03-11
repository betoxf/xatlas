import SwiftUI

struct ContentAreaView: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            if state.selectedSection == .projects {
                // Minimal tab strip — only if multiple tabs
                if state.tabs.count > 1 {
                    tabBar
                }

                if let tab = state.selectedTab {
                    tabContent(tab)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    emptyState
                }

                CommandBarView(state: state)
            } else {
                WorkspaceSectionView(state: state)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
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
                appState: state
            )
            .id(sessionID)
        case .editor(let filePath):
            EditorView(filePath: filePath)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Button {
                _ = state.createTerminalForSelectedProject()
            } label: {
                Label("New Terminal", systemImage: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(.white.opacity(0.52)))
            }
            .buttonStyle(.plain)
            Text("Press ⌘K to open command bar")
                .font(XatlasFont.mono)
                .foregroundStyle(.secondary)
            Text("Typing in the command bar will also create one automatically.")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            state.isCommandBarFocused = true
        }
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
