import AppKit
import SwiftUI

struct ProjectDashboardView: View {
    @Bindable var state: AppState

    private let columns = [
        GridItem(.adaptive(minimum: 260, maximum: 340), spacing: 18, alignment: .top)
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
    @State private var isSummarizing = false

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

    private var isSelected: Bool {
        state.selectedProject?.id == project.id && state.projectSurfaceMode == .workspace
    }

    var body: some View {
        let _ = state.terminalEventVersion

        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(project.name)
                            .font(.system(size: 20, weight: .semibold))
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

            HStack(spacing: 8) {
                dashboardBadge(text: gitStatus.isRepo ? gitStatus.branch : "folder", tint: .blue)
                dashboardBadge(text: "\(sessions.count) visible", tint: .green)
                if gitStatus.isRepo {
                    dashboardBadge(text: "\(gitStatus.changes.count) change\(gitStatus.changes.count == 1 ? "" : "s")", tint: gitStatus.changes.isEmpty ? .gray : .orange)
                }
                if hiddenSessionCount > 0 {
                    dashboardBadge(text: "+\(hiddenSessionCount) older", tint: .secondary)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(primarySessionTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary.opacity(0.78))
                    .lineLimit(1)

                Text(primarySessionSubtitle)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.34))
            )

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Live Preview")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(previewStateLabel)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(previewStateColor)
                }

                Text(previewText)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.72))
                    .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading)
                    .lineLimit(5)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.black.opacity(0.045))
            )

            HStack(spacing: 8) {
                actionButton(label: "Open", icon: "rectangle.stack") {
                    state.switchToProject(project)
                }

                actionButton(label: "Quick View", icon: "macwindow") {
                    onQuickView()
                }

                actionButton(label: isSummarizing ? "Running" : "Brief", icon: "sparkles", disabled: isSummarizing) {
                    isSummarizing = true
                    let sessionID = state.runProjectBrief(for: project)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                        isSummarizing = false
                        if sessionID == nil {
                            NSSound.beep()
                        }
                    }
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: 306, alignment: .topLeading)
        .background(cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(strokeColor, lineWidth: isSelected ? 1.4 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture {
            state.switchToProject(project)
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

    private var primarySessionTitle: String {
        primarySession?.displayTitle ?? "No terminal yet"
    }

    private var primarySessionSubtitle: String {
        if let session = primarySession {
            if session.requiresAttention {
                return "Finished work and waiting for review."
            }
            return session.activityState.label
        }
        return "Open the project to start a terminal or run a brief AI summary."
    }

    private var previewStateLabel: String {
        primarySession?.activityState.label ?? "Idle"
    }

    private var previewStateColor: Color {
        guard let state = primarySession?.activityState else { return .secondary }
        switch state {
        case .idle: return .blue.opacity(0.78)
        case .running: return .green.opacity(0.82)
        case .detached: return .orange.opacity(0.82)
        case .exited: return .secondary
        case .error: return .red.opacity(0.82)
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
        previewText = lines.suffix(5).joined(separator: "\n")
    }

    private func dashboardBadge(text: String, tint: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .foregroundStyle(tint.opacity(0.8))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(tint.opacity(0.08)))
    }

    private func actionButton(label: String, icon: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(disabled ? Color.secondary : Color.primary.opacity(0.8))
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                Capsule().fill(.white.opacity(disabled ? 0.18 : 0.42))
            )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

private struct ProjectQuickViewSheet: View {
    let project: Project
    @Bindable var state: AppState

    @Environment(\.dismiss) private var dismiss
    @State private var showAllSessions = false
    @State private var selectedSessionID: String?
    @State private var snapshotText = "No terminal selected."

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
                        selectedSessionID = sessions.first?.id
                        refreshSnapshot()
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
                            refreshSnapshot()
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
                        refreshSnapshot()
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

            ScrollView {
                Text(snapshotText)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.8))
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(16)
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
                    refreshSnapshot()
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.5)))

                if let selectedSession {
                    Button("Close Terminal") {
                        _ = state.closeTerminalSession(selectedSession.id)
                        selectedSessionID = sessions.first(where: { $0.id != selectedSession.id })?.id
                        refreshSnapshot()
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
            selectedSessionID = sessions.first?.id
            refreshSnapshot()
        }
        .onChange(of: state.terminalEventVersion) { _, _ in
            refreshSnapshot()
        }
        .onExitCommand {
            state.closeProjectQuickView()
            dismiss()
        }
    }

    private func refreshSnapshot() {
        guard let session = selectedSession,
              let snapshot = TerminalService.shared.snapshot(for: session.id, lines: 160) else {
            snapshotText = "No terminal selected."
            return
        }
        snapshotText = snapshot
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
            .frame(maxWidth: .infinity, minHeight: 306)
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
