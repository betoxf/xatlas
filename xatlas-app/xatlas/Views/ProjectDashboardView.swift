import AppKit
import SwiftUI

struct ProjectDashboardView: View {
    @Bindable var state: AppState

    private let columns = [
        GridItem(.adaptive(minimum: 220, maximum: 280), spacing: 16, alignment: .top)
    ]

    private var quickViewProject: Project? {
        guard let projectID = state.dashboardQuickViewProjectID else { return nil }
        return state.projects.first(where: { $0.id == projectID })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Projects")
                            .font(.system(size: 22, weight: .semibold))
                        Text("Switch between repos, inspect live terminal activity, and open a quick preview without leaving the overview.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                    }

                    Spacer()

                    Button {
                        openFolderPicker()
                    } label: {
                        Label("Add Project", systemImage: "plus")
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(Capsule().fill(.white.opacity(0.48)))
                    }
                    .buttonStyle(.plain)
                }

                LazyVGrid(columns: columns, spacing: 18) {
                    ForEach(state.projects) { project in
                        ProjectDashboardCard(
                            project: project,
                            state: state,
                            onQuickView: {
                                _ = state.openProjectQuickView(id: project.id)
                            }
                        )
                    }

                    AddProjectTile(action: openFolderPicker)
                }
            }
            .padding(18)
        }
        .sheet(item: Binding(
            get: { quickViewProject },
            set: { newValue in
                if let newValue {
                    state.dashboardQuickViewProjectID = newValue.id
                } else {
                    state.closeProjectQuickView()
                }
            }
        )) { project in
            ProjectQuickViewSheet(project: project, state: state)
        }
    }

    private func openFolderPicker() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select a project folder"
        panel.prompt = "Open"
        panel.begin { response in
            if response == .OK, let url = panel.url {
                state.addProject(name: url.lastPathComponent, path: url.path)
            }
        }
    }
}

private struct ProjectDashboardCard: View {
    let project: Project
    @Bindable var state: AppState
    let onQuickView: () -> Void

    @State private var gitStatus = GitStatus(branch: "", changes: [], isRepo: false)
    @State private var previewText = "No terminal output yet."
    @State private var isHovered = false

    private var sessions: [TerminalSession] {
        TerminalService.shared.visibleSessionsForProject(project.id, maxDetached: 3)
    }

    private var primarySession: TerminalSession? {
        sessions.first
    }

    private var hiddenSessionCount: Int {
        TerminalService.shared.hiddenSessionCountForProject(project.id, maxDetached: 3)
    }

    private var attentionCount: Int {
        state.projectAttentionCount(project.id)
    }

    private var badgeCount: Int {
        var count = 2
        if gitStatus.isRepo {
            count += 1
        }
        if hiddenSessionCount > 0 {
            count += 1
        }
        return count
    }

    private var compactBadges: Bool {
        badgeCount >= 4
    }

    private var branchBadgeText: String {
        gitStatus.isRepo ? gitStatus.branch : "folder"
    }

    private var visibleBadgeText: String {
        compactBadges ? "\(sessions.count) live" : "\(sessions.count) visible"
    }

    private var changesBadgeText: String {
        let count = gitStatus.changes.count
        if compactBadges {
            return "\(count) chg"
        }
        return "\(count) change\(count == 1 ? "" : "s")"
    }

    private var olderBadgeText: String {
        compactBadges ? "+\(hiddenSessionCount)" : "+\(hiddenSessionCount) older"
    }

    private var isSelected: Bool {
        state.selectedProject?.id == project.id && state.projectSurfaceMode == .workspace
    }

    var body: some View {
        let _ = state.terminalEventVersion

        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(project.name)
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        if attentionCount > 0 {
                            Text("\(attentionCount)")
                                .font(.system(size: 10, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(.red.opacity(0.8)))
                        }
                    }

                    Text(project.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary.opacity(0.55))
            }

            HStack(spacing: compactBadges ? 5 : 8) {
                dashboardBadge(text: branchBadgeText, tint: .blue, compact: compactBadges)
                dashboardBadge(text: visibleBadgeText, tint: .green, compact: compactBadges)
                if gitStatus.isRepo {
                    dashboardBadge(
                        text: changesBadgeText,
                        tint: gitStatus.changes.isEmpty ? .gray : .orange,
                        compact: compactBadges
                    )
                }
                if hiddenSessionCount > 0 {
                    dashboardBadge(text: olderBadgeText, tint: .secondary, compact: compactBadges)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: 8) {
                Text("Live Preview")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)

                Text(previewText)
                    .font(.system(size: 7.25, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.72))
                    .lineSpacing(0)
                    .frame(maxWidth: .infinity, minHeight: 88, maxHeight: 88, alignment: .topLeading)
                    .lineLimit(8)
                    .fixedSize(horizontal: false, vertical: true)
                    .clipped()
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.black.opacity(0.045))
            )
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 236, maxHeight: 236, alignment: .topLeading)
        .background(cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(strokeColor, lineWidth: isSelected ? 1.4 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture {
            onQuickView()
        }
        .onHover { isHovered = $0 }
        .onAppear {
            refresh()
            refreshPreview()
        }
        .onChange(of: state.terminalEventVersion) { _, _ in
            refreshPreview()
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(.white.opacity(isHovered || isSelected ? 0.62 : 0.48))
            .shadow(color: .black.opacity(isSelected ? 0.12 : 0.08), radius: 16, y: 8)
    }

    private var strokeColor: Color {
        if isSelected {
            return .accentColor.opacity(0.58)
        }
        return .white.opacity(0.32)
    }

    private func refresh() {
        Task.detached { [path = project.path] in
            let status = GitService.shared.status(at: path)
            await MainActor.run {
                gitStatus = status
            }
        }
    }

    private func refreshPreview() {
        guard let session = primarySession,
              let snapshot = TerminalService.shared.snapshot(for: session.id, lines: 12) else {
            previewText = "No terminal output yet."
            return
        }

        let lines = snapshot
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { line in
                if line.count > 28 {
                    return String(line.prefix(28)) + "…"
                }
                return line
            }
        previewText = lines.suffix(6).joined(separator: "\n")
    }

    private func dashboardBadge(text: String, tint: Color, compact: Bool) -> some View {
        Text(text)
            .font(.system(size: compact ? 8 : 9.25, weight: .semibold, design: .rounded))
            .foregroundStyle(tint.opacity(0.8))
            .padding(.horizontal, compact ? 5 : 8)
            .padding(.vertical, compact ? 2.5 : 4)
            .background(Capsule().fill(tint.opacity(0.08)))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

}

private struct ProjectQuickViewSheet: View {
    let project: Project
    @Bindable var state: AppState

    @Environment(\.dismiss) private var dismiss
    @State private var showAllSessions = false
    @State private var selectedSessionID: String?
    @State private var pendingCloseSessionID: String?

    private var sessions: [TerminalSession] {
        if showAllSessions {
            return TerminalService.shared
                .sessionsForProject(project.id)
                .filter { $0.activityState != .exited }
                .sorted(by: sessionPriority)
        }

        return TerminalService.shared.visibleSessionsForProject(project.id, maxDetached: 6)
    }

    private var selectedSession: TerminalSession? {
        if let selectedSessionID,
           let session = sessions.first(where: { $0.id == selectedSessionID }) {
            return session
        }
        return sessions.first
    }

    private var hiddenSessionCount: Int {
        if showAllSessions { return 0 }
        return TerminalService.shared.hiddenSessionCountForProject(project.id, maxDetached: 6)
    }

    private var totalVisibleSessionCount: Int {
        TerminalService.shared.sessionsForProject(project.id).filter { $0.activityState != .exited }.count
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
                        syncSelectedSession()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(Capsule().fill(.white.opacity(0.42)))
                }

                Button("Done") {
                    state.closeProjectQuickView()
                    dismiss()
                }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.55)))
            }
            .padding(20)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(sessions) { session in
                        Button {
                            selectedSessionID = session.id
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "terminal")
                                    .font(.system(size: 10, weight: .semibold))
                                Text(session.displayTitle)
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
                            .foregroundStyle(selectedSession?.id == session.id ? Color.white : Color.primary.opacity(0.75))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(
                                Capsule().fill(selectedSession?.id == session.id ? Color.accentColor : Color.white.opacity(0.35))
                            )
                        }
                        .buttonStyle(.plain)
                    }

                    Button {
                        let tab = state.createTerminal(for: project)
                        if case .terminal(let sessionID) = tab.kind {
                            selectedSessionID = sessionID
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

            Group {
                if let selectedSession {
                    StyledTerminalView(sessionID: selectedSession.id, appState: state)
                        .id(selectedSession.id)
                } else {
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
            }
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.black.opacity(0.05))
            )
            .padding(.horizontal, 20)
            .padding(.bottom, 16)

            HStack(spacing: 10) {
                Button("Open Workspace") {
                    state.switchToProject(project)
                    state.closeProjectQuickView()
                    dismiss()
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.5)))

                Button("Refresh") {
                    syncSelectedSession()
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.5)))

                if let selectedSession {
                    Button("Close Terminal") {
                        requestClose(selectedSession.id)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(.white.opacity(0.5)))
                }

                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .frame(width: 860, height: 620)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            syncSelectedSession()
        }
        .onChange(of: state.terminalEventVersion) { _, _ in
            syncSelectedSession()
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
        .onExitCommand {
            state.closeProjectQuickView()
            dismiss()
        }
    }

    private func syncSelectedSession() {
        if let selectedSessionID,
           sessions.contains(where: { $0.id == selectedSessionID }) {
            return
        }
        self.selectedSessionID = sessions.first?.id
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
    }

    private func sessionPriority(_ lhs: TerminalSession, _ rhs: TerminalSession) -> Bool {
        let lhsRank = rank(for: lhs)
        let rhsRank = rank(for: rhs)
        if lhsRank != rhsRank {
            return lhsRank < rhsRank
        }
        return lhs.updatedAt > rhs.updatedAt
    }

    private func rank(for session: TerminalSession) -> Int {
        if session.requiresAttention { return 0 }
        switch session.activityState {
        case .running: return 1
        case .idle: return 2
        case .detached: return 3
        case .error: return 4
        case .exited: return 5
        }
    }
}

private struct AddProjectTile: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 12) {
                Image(systemName: "plus")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(.secondary.opacity(0.8))
                Text("Add Project")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 236, maxHeight: 236)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [7, 7]))
                    .foregroundStyle(.secondary.opacity(isHovered ? 0.45 : 0.25))
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}
