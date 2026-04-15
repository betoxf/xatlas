import SwiftUI

struct ContentAreaView: View {
    @Bindable var state: AppState
    @State private var terminalService = TerminalService.shared
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
                        title: tab.resolvedTitle(using: terminalService),
                        isTerminal: tab.kind.isTerminal,
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
                                .overlay(
                                    RoundedRectangle(cornerRadius: XatlasLayout.compactCornerRadius, style: .continuous)
                                        .strokeBorder(.white.opacity(0.40), lineWidth: 0.6)
                                )
                        )
                }
                .buttonStyle(.plain)
                .xatlasPressEffect()
            }
            .padding(.horizontal, XatlasLayout.contentInset)
            .padding(.vertical, 10)
        }
        .frame(height: 42)
        .overlay(alignment: .bottom) {
            xatlasFadingDivider()
                .padding(.horizontal, XatlasLayout.contentInset)
        }
    }

    private func requiresAttention(for tab: TabItem) -> Bool {
        guard case .terminal(let sessionID) = tab.kind else { return false }
        return terminalService.session(id: sessionID)?.requiresAttention ?? false
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
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(.tertiary)
            Button {
                _ = state.createTerminalForSelectedProject()
            } label: {
                Label("New Terminal", systemImage: "plus")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(
                        Capsule()
                            .fill(.white.opacity(0.52))
                            .overlay(
                                Capsule()
                                    .strokeBorder(.white.opacity(0.42), lineWidth: 0.6)
                            )
                            .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
                    )
            }
            .buttonStyle(.plain)
            .xatlasPressEffect()
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
    let title: String
    let isTerminal: Bool
    let requiresAttention: Bool
    let isSelected: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Button(action: onSelect) {
                HStack(spacing: 4) {
                    Image(systemName: isTerminal ? "terminal" : "doc.text")
                        .font(.system(size: 10, weight: .medium))

                    Text(title)
                        .font(XatlasFont.monoSmall)
                        .lineLimit(1)

                    if requiresAttention {
                        Text("1")
                            .font(XatlasFont.badge)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .xatlasBadgeFill(tint: .red)
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
            .xatlasPressEffect(scale: 0.85)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(chipBackground)
        .contentShape(Rectangle())
        .animation(XatlasMotion.layout, value: isSelected)
    }

    @ViewBuilder
    private var chipBackground: some View {
        if isSelected {
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(.white.opacity(0.78))
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [.white.opacity(0.30), .white.opacity(0.0)],
                                startPoint: .top,
                                endPoint: UnitPoint(x: 0.5, y: 0.34)
                            )
                        )
                        .allowsHitTesting(false)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [.white.opacity(0.85), .white.opacity(0.32)],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.7
                        )
                )
                .shadow(color: .black.opacity(0.07), radius: 3, y: 1)
                .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        } else {
            Color.clear
        }
    }
}

extension TabItem.TabKind {
    var isTerminal: Bool {
        if case .terminal = self { return true }
        return false
    }
}
