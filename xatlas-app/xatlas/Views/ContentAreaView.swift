import SwiftUI

struct ContentAreaView: View {
    @Bindable var state: AppState
    @State private var pendingCloseSessionID: String?
    @State private var terminalFocusToken = 0

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
        .confirmationDialog(
            "Close running terminal?",
            isPresented: Binding(
                get: { pendingCloseSessionID != nil },
                set: { if !$0 { pendingCloseSessionID = nil } }
            )
        ) {
            Button("Close and Kill Terminal", role: .destructive) {
                if let pendingCloseSessionID {
                    _ = state.closeTerminalSession(pendingCloseSessionID, killTmux: true)
                    self.pendingCloseSessionID = nil
                }
            }
            Button("Cancel", role: .cancel) {
                pendingCloseSessionID = nil
            }
        } message: {
            Text("This terminal looks active. Closing it will kill the backing tmux session everywhere.")
        }
        .onAppear(perform: requestTerminalFocusIfNeeded)
        .onChange(of: state.selectedProject?.id) { _, _ in
            requestTerminalFocusIfNeeded()
        }
        .onChange(of: state.selectedTab?.id) { _, _ in
            requestTerminalFocusIfNeeded()
        }
        .onChange(of: state.projectSurfaceMode) { _, _ in
            requestTerminalFocusIfNeeded()
        }
    }

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(state.tabs) { tab in
                    TabButton(
                        tab: tab,
                        requiresAttention: requiresAttention(for: tab),
                        isSelected: state.selectedTab?.id == tab.id,
                        onSelect: {
                            state.selectedTab = tab
                            requestTerminalFocusIfNeeded()
                        },
                        onClose: { requestClose(for: tab) }
                    )
                }

                Button {
                    _ = state.createTerminalForSelectedProject()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.primary.opacity(0.65))
                        .frame(width: XatlasLayout.compactControlSize, height: XatlasLayout.compactControlSize)
                        .background(
                            RoundedRectangle(cornerRadius: XatlasLayout.compactCornerRadius, style: .continuous)
                                .fill(.white.opacity(0.5))
                        )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, XatlasLayout.contentInset)
            .padding(.vertical, 10)
        }
        .frame(height: 42)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(XatlasSurface.divider)
                .frame(height: 1)
                .padding(.horizontal, XatlasLayout.contentInset)
        }
    }

    private func requiresAttention(for tab: TabItem) -> Bool {
        guard case .terminal(let sessionID) = tab.kind else { return false }
        _ = state.terminalEventVersion
        return state.terminalRequiresAttention(sessionID)
    }

    private func requestClose(for tab: TabItem) {
        switch tab.kind {
        case .terminal(let sessionID):
            if state.terminalNeedsCloseConfirmation(sessionID) {
                pendingCloseSessionID = sessionID
            } else {
                _ = state.closeTerminalSession(sessionID, killTmux: true)
            }
        case .editor:
            state.closeTab(tab)
        }
    }

    @ViewBuilder
    private func tabContent(_ tab: TabItem) -> some View {
        switch tab.kind {
        case .terminal(let sessionID):
            StyledTerminalView(
                sessionID: sessionID,
                appState: state,
                focusToken: terminalFocusToken
            )
        case .editor(let filePath):
            EditorView(filePath: filePath)
        }
    }

    private func requestTerminalFocusIfNeeded() {
        guard state.selectedSection == .projects,
              state.projectSurfaceMode == .workspace,
              let selectedTab = state.selectedTab,
              selectedTab.kind.isTerminal else { return }
        terminalFocusToken &+= 1
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
            Button(action: onSelect) {
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
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
            }
            .buttonStyle(.plain)
            .opacity(isSelected ? 0.6 : 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            isSelected ? .white.opacity(0.55) : .clear,
            in: RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
        )
        .contentShape(Rectangle())
    }
}

extension TabItem.TabKind {
    var isTerminal: Bool {
        if case .terminal = self { return true }
        return false
    }
}
