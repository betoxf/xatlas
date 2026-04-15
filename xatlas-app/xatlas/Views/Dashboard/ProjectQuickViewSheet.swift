import AppKit
import SwiftUI

/// Modal sheet that drops down from the dashboard when a project card is
/// tapped. Shows session chips, an active terminal, and project-level
/// actions without leaving the dashboard surface.
struct ProjectQuickViewSheet: View {
    let project: Project
    @Bindable var state: AppState
    let isPresented: Bool

    @State private var showAllSessions = false
    @State private var sessionDisplayOrder: [String] = []
    @State private var selectedSessionID: String?
    @State private var pendingCloseSessionID: String?
    @State private var isProjectCloseConfirmationPresented = false
    @State private var terminalFocusToken = 0
    @State private var dragOffset: CGSize = .zero
    @State private var dragAccumulated: CGSize = .zero
    @State private var terminalService = TerminalService.shared

    private var allProjectSessions: [TerminalSession] {
        terminalService.liveSessionsForProject(project.id)
    }

    private var visibleSessions: [TerminalSession] {
        if showAllSessions {
            return allProjectSessions.sorted(by: TerminalSession.priorityOrder)
        }

        return terminalService.visibleSessionsForProject(project.id, maxDetached: 6)
    }

    private var sessions: [TerminalSession] {
        let visibleIDs = Set(visibleSessions.map(\.id))
        let sessionsByID = Dictionary(uniqueKeysWithValues: visibleSessions.map { ($0.id, $0) })
        let ordered = sessionDisplayOrder.compactMap { sessionID -> TerminalSession? in
            guard visibleIDs.contains(sessionID) else { return nil }
            return sessionsByID[sessionID]
        }
        let orderedIDs = Set(ordered.map(\.id))
        let appended = visibleSessions
            .filter { !orderedIDs.contains($0.id) }
            .sorted(by: TerminalSession.creationOrder)
        return ordered + appended
    }

    private var activeSessionID: String? {
        if let selectedSessionID, sessions.contains(where: { $0.id == selectedSessionID }) {
            return selectedSessionID
        }
        return sessions.first?.id
    }

    private var hiddenSessionCount: Int {
        if showAllSessions { return 0 }
        return terminalService.hiddenSessionCountForProject(project.id, maxDetached: 6)
    }

    private var totalVisibleSessionCount: Int {
        state.projectLiveSessionCount(project.id)
    }

    private var projectCloseWarningText: String {
        state.projectCloseWarningText(for: project)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(project.name)
                        .font(.system(size: 18, weight: .semibold))
                    Text(project.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if showAllSessions || hiddenSessionCount > 0 {
                    Button(showAllSessions ? "Recent" : "Show All \(totalVisibleSessionCount)") {
                        showAllSessions.toggle()
                        reconcileSessionState()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(Capsule().fill(.white.opacity(0.42)))
                }

                Button("Done") {
                    state.closeProjectQuickView()
                }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.55)))
            }
            .padding(20)
            .gesture(
                DragGesture()
                    .onChanged { value in
                        dragOffset = CGSize(
                            width: dragAccumulated.width + value.translation.width,
                            height: dragAccumulated.height + value.translation.height
                        )
                    }
                    .onEnded { _ in
                        dragAccumulated = dragOffset
                    }
            )

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(sessions) { session in
                        HStack(spacing: 6) {
                            Button {
                                selectSession(session.id)
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "terminal")
                                        .font(.system(size: 10, weight: .semibold))
                                    Text(sessionChipTitle(for: session))
                                        .font(.system(size: 11, weight: .semibold))
                                    if session.requiresAttention {
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

                            Button {
                                requestClose(session.id)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 8, weight: .bold))
                            }
                            .buttonStyle(.plain)
                            .opacity(activeSessionID == session.id ? 0.6 : 0)
                        }
                        .foregroundStyle(activeSessionID == session.id ? Color.white : Color.primary.opacity(0.75))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(
                            Capsule().fill(activeSessionID == session.id ? Color.accentColor : Color.white.opacity(0.35))
                        )
                    }

                    Button {
                        let tab = state.createTerminal(for: project)
                        if case .terminal(let sessionID) = tab.kind {
                            selectSession(sessionID)
                            reconcileSessionState()
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.primary.opacity(0.65))
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(.white.opacity(0.35)))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 20)
            }
            .padding(.bottom, 12)

            terminalArea
                .clipped()
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.black.opacity(0.05))
                )
                .padding(.horizontal, 20)
                .padding(.bottom, 16)

            HStack(spacing: 10) {
                Button("Open Workspace") {
                    state.switchToProject(project)
                    if let activeSessionID {
                        _ = state.openTerminalSession(activeSessionID)
                    }
                    state.closeProjectQuickView()
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.5)))

                Button("Refresh") {
                    reconcileSessionState()
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.5)))

                Button("Close Project") {
                    isProjectCloseConfirmationPresented = true
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(Color.red.opacity(0.14)))

                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .frame(width: 860, height: 620)
        .background(Color(nsColor: .windowBackgroundColor))
        .offset(dragOffset)
        .onAppear {
            reconcileSessionState()
            requestTerminalFocus()
        }
        .onChange(of: isPresented) { _, presented in
            guard presented else { return }
            reconcileSessionState()
            requestTerminalFocus()
        }
        .onChange(of: activeSessionID) { _, sessionID in
            state.setQuickViewSelectedSessionID(sessionID, for: project.id)
            if sessionID != nil {
                requestTerminalFocus()
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
                    completeClose(for: pendingCloseSessionID)
                }
            }
            Button("Cancel", role: .cancel) {
                pendingCloseSessionID = nil
            }
        } message: {
            Text("This terminal looks active. Closing it will kill the backing tmux session everywhere.")
        }
        .confirmationDialog(
            "Close project?",
            isPresented: $isProjectCloseConfirmationPresented
        ) {
            Button("Close Project and Kill Terminals", role: .destructive) {
                completeProjectClose()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(projectCloseWarningText)
        }
        .onExitCommand {
            state.closeProjectQuickView()
        }
    }

    @ViewBuilder
    private var terminalArea: some View {
        if sessions.isEmpty {
            emptyTerminalState
        } else if let activeSessionID {
            StyledTerminalView(
                sessionID: activeSessionID,
                appState: state,
                focusToken: terminalFocusToken
            )
        } else {
            emptyTerminalState
        }
    }

    private var emptyTerminalState: some View {
        VStack(spacing: 10) {
            Image(systemName: "terminal")
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(.secondary)
            Text("No terminal selected")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(16)
    }

    private func reconcileSessionState() {
        let liveSessionIDs = Set(allProjectSessions.map(\.id))
        sessionDisplayOrder.removeAll { !liveSessionIDs.contains($0) }

        let knownSessionIDs = Set(sessionDisplayOrder)
        sessionDisplayOrder.append(contentsOf: allProjectSessions
            .filter { !knownSessionIDs.contains($0.id) }
            .sorted(by: TerminalSession.creationOrder)
            .map(\.id))

        let preferredSessionID = state.preferredProjectSessionID(
            for: project.id,
            availableSessionIDs: sessions.map(\.id),
            fallbackSelection: selectedSessionID
        )
        guard preferredSessionID != selectedSessionID else { return }
        selectSession(preferredSessionID)
    }

    private func requestClose(_ sessionID: String) {
        if state.terminalNeedsCloseConfirmation(sessionID) {
            pendingCloseSessionID = sessionID
        } else {
            completeClose(for: sessionID)
        }
    }

    private func completeClose(for sessionID: String) {
        let nextSessionID = sessions.first(where: { $0.id != sessionID })?.id
        _ = state.closeTerminalSession(sessionID, killTmux: true)
        pendingCloseSessionID = nil
        selectedSessionID = nextSessionID
        state.setQuickViewSelectedSessionID(nextSessionID, for: project.id)
        sessionDisplayOrder.removeAll { $0 == sessionID }
    }

    private func completeProjectClose() {
        isProjectCloseConfirmationPresented = false
        state.closeProjectQuickView()
        _ = state.removeProject(project)
    }

    private func sessionChipTitle(for session: TerminalSession) -> String {
        let peers = allProjectSessions
            .filter { $0.displayTitle == session.displayTitle }
            .sorted(by: TerminalSession.creationOrder)
        guard peers.count > 1 else { return session.displayTitle }
        let ordinal = (peers.firstIndex(where: { $0.id == session.id }) ?? 0) + 1
        return "\(session.displayTitle) \(ordinal)"
    }

    private func requestTerminalFocus() {
        terminalFocusToken &+= 1
    }

    private func selectSession(_ sessionID: String?) {
        let didChange = selectedSessionID != sessionID
        selectedSessionID = sessionID
        state.setQuickViewSelectedSessionID(sessionID, for: project.id)

        if sessionID != nil {
            if didChange {
                DispatchQueue.main.async {
                    requestTerminalFocus()
                }
            } else {
                requestTerminalFocus()
            }
        }
    }
}
