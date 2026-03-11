import SwiftUI

struct ContentAreaView: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            if state.selectedSection == .projects {
                if state.projectSurfaceMode == .dashboard {
                    ProjectDashboardView(state: state)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    if !state.tabs.isEmpty {
                        tabBar
                    }

                    if let tab = state.selectedTab {
                        tabContent(tab)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        emptyState
                    }

                    CommandBarView(state: state)
                }
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
                        requiresAttention: requiresAttention(for: tab),
                        isSelected: state.selectedTab?.id == tab.id,
                        onSelect: { state.selectedTab = tab },
                        onClose: { state.closeTab(tab) }
                    )
                }

                Button {
                    _ = state.createTerminalForSelectedProject()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.primary.opacity(0.65))
                        .frame(width: 22, height: 22)
                        .background(
                            Circle().fill(.white.opacity(0.38))
                        )
                }
                .buttonStyle(.plain)
                .padding(.leading, 4)
            }
            .padding(.horizontal, 8)
        }
        .frame(height: 30)
        .background(.ultraThinMaterial)
    }

    private func requiresAttention(for tab: TabItem) -> Bool {
        guard case .terminal(let sessionID) = tab.kind else { return false }
        _ = state.terminalEventVersion
        return state.terminalRequiresAttention(sessionID)
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
    let requiresAttention: Bool
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

            if requiresAttention {
                Text("1")
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(.red.opacity(0.78)))
            }

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
