import AppKit
import SwiftUI

struct ProjectDashboardView: View {
    @Bindable var state: AppState
    @State private var operatorService = ProjectOperatorService.shared
    @State private var operatorInput = ""
    @State private var isOperatorCollapsed = false
    @FocusState private var isOperatorFocused: Bool

    private let columns = [
        GridItem(.adaptive(minimum: 240, maximum: 300), spacing: 18, alignment: .top)
    ]

    private var filteredProjects: [Project] {
        let query = state.dashboardSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return state.projects }
        return state.projects.filter { $0.name.lowercased().contains(query) }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 20) {
                    ForEach(filteredProjects) { project in
                        ProjectDashboardCard(
                            project: project,
                            state: state,
                            onQuickView: {
                                _ = state.openProjectQuickView(id: project.id)
                            }
                        )
                    }

                    AddProjectTile(action: state.presentProjectPicker)
                }
                .padding(20)
                .padding(.bottom, isOperatorCollapsed ? 104 : 216)
            }

            DashboardOperatorOverlay(
                messages: operatorService.consoleMessages.suffix(6).map { $0 },
                isReady: operatorService.isGlobalOperatorReady,
                input: $operatorInput,
                isCollapsed: $isOperatorCollapsed,
                isFocused: $isOperatorFocused,
                addProject: state.presentProjectPicker,
                send: sendOperatorMessage
            )
            .padding(.horizontal, 26)
            .padding(.bottom, 18)
        }
    }

    private func sendOperatorMessage() {
        let trimmed = operatorInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = operatorService.sendConsoleMessage(trimmed, preferredProject: nil)
        operatorInput = ""
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

        VStack(alignment: .leading, spacing: 14) {
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
                    .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52, alignment: .topLeading)
                    .lineLimit(5)
                    .fixedSize(horizontal: false, vertical: true)
                    .clipped()
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.black.opacity(0.04))
            )
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: 214, maxHeight: 214, alignment: .topLeading)
        .background(cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: XatlasLayout.panelCornerRadius, style: .continuous)
                .strokeBorder(strokeColor, lineWidth: isSelected ? 1.4 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: XatlasLayout.panelCornerRadius, style: .continuous))
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
        RoundedRectangle(cornerRadius: XatlasLayout.panelCornerRadius, style: .continuous)
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

private struct DashboardOperatorOverlay: View {
    let messages: [OperatorConsoleMessage]
    let isReady: Bool
    @Binding var input: String
    @Binding var isCollapsed: Bool
    var isFocused: FocusState<Bool>.Binding
    let addProject: () -> Void
    let send: () -> Void
    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !isCollapsed && !messages.isEmpty {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(messages) { message in
                            OperatorBubble(message: message)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 2)
                }
                .frame(maxHeight: 132)
                .padding(.bottom, 2)
            }

            VStack(alignment: .leading, spacing: 10) {
                operatorHandle

                HStack(alignment: .bottom, spacing: 10) {
                    Button(action: addProject) {
                        Image(systemName: "plus")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.primary.opacity(0.52))
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)

                    TextField(placeholder, text: $input, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1...4)
                        .focused(isFocused)
                        .onTapGesture {
                            if isCollapsed {
                                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                                    isCollapsed = false
                                }
                            }
                        }
                        .onSubmit(send)

                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 24, weight: .semibold))
                            .foregroundStyle(
                                input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    ? Color.secondary.opacity(0.35)
                                    : Color.primary
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .background(sheetBackground)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(.white.opacity(isInteractive ? 0.74 : 0.56), lineWidth: 1)
            )
            .shadow(color: .black.opacity(isInteractive ? 0.08 : 0.05), radius: isInteractive ? 16 : 12, y: 4)
        }
        .frame(maxWidth: 680)
        .frame(maxWidth: .infinity, alignment: .center)
        .onHover { isHovered = $0 }
        .animation(.spring(response: 0.28, dampingFraction: 0.86), value: isCollapsed)
    }

    private var isInteractive: Bool {
        isHovered || isFocused.wrappedValue
    }

    private var placeholder: String {
        isReady
            ? "Message the operator. Codex --yolo is running in the background…"
            : "Starting the Codex operator…"
    }

    private var sheetBackground: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(Color.white.opacity(isInteractive ? 0.95 : 0.89))
    }

    private var operatorHandle: some View {
        Capsule()
            .fill(Color.black.opacity(0.14))
            .frame(width: 48, height: 5)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                    isCollapsed.toggle()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 8)
                    .onEnded { value in
                        if value.translation.height > 18 {
                            withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                                isCollapsed = true
                            }
                        } else if value.translation.height < -18 {
                            withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                                isCollapsed = false
                            }
                        }
                    }
            )
    }
}

private struct OperatorBubble: View {
    let message: OperatorConsoleMessage

    var body: some View {
        HStack {
            if message.role == .user {
                Spacer(minLength: 80)
            }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 5) {
                Text(message.text)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(message.role == .user ? .white : .primary.opacity(0.84))
                    .lineSpacing(1.5)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(bubbleBackground)
            .frame(maxWidth: 420, alignment: message.role == .user ? .trailing : .leading)

            if message.role == .assistant {
                Spacer(minLength: 80)
            }
        }
    }

    @ViewBuilder
    private var bubbleBackground: some View {
        if message.role == .user {
            UnevenRoundedRectangle(
                topLeadingRadius: 18,
                bottomLeadingRadius: 18,
                bottomTrailingRadius: 6,
                topTrailingRadius: 18
            )
            .fill(Color.accentColor.opacity(0.9))
            .shadow(color: Color.accentColor.opacity(0.14), radius: 10, x: 0, y: 5)
        } else {
            UnevenRoundedRectangle(
                topLeadingRadius: 18,
                bottomLeadingRadius: 6,
                bottomTrailingRadius: 18,
                topTrailingRadius: 18
            )
            .fill(.white.opacity(0.74))
            .overlay(
                UnevenRoundedRectangle(
                    topLeadingRadius: 18,
                    bottomLeadingRadius: 6,
                    bottomTrailingRadius: 18,
                    topTrailingRadius: 18
                )
                .stroke(.white.opacity(0.58), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.05), radius: 8, x: 0, y: 4)
        }
    }
}

struct ProjectQuickViewSheet: View {
    let project: Project
    @Bindable var state: AppState

    private struct SessionChipIdentity {
        let baseTitle: String
        let ordinal: Int
    }

    @State private var showAllSessions = false
    @State private var sessionDisplayOrder: [String] = []
    @State private var selectedSessionID: String?
    @State private var pendingCloseSessionID: String?
    @State private var isProjectCloseConfirmationPresented = false
    @State private var sessionChipIdentities: [String: SessionChipIdentity] = [:]
    @State private var nextOrdinalByTitle: [String: Int] = [:]
    @State private var terminalFocusToken = 0
    @State private var dragOffset: CGSize = .zero
    @State private var dragAccumulated: CGSize = .zero

    private var allProjectSessions: [TerminalSession] {
        TerminalService.shared
            .sessionsForProject(project.id)
            .filter { $0.activityState != .exited }
    }

    private var visibleSessions: [TerminalSession] {
        if showAllSessions {
            return allProjectSessions.sorted(by: sessionPriority)
        }

        return TerminalService.shared.visibleSessionsForProject(project.id, maxDetached: 6)
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
            .sorted(by: sessionCreationOrder)
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
        return TerminalService.shared.hiddenSessionCountForProject(project.id, maxDetached: 6)
    }

    private var totalVisibleSessionCount: Int {
        TerminalService.shared.sessionsForProject(project.id).filter { $0.activityState != .exited }.count
    }

    private var projectCloseWarningText: String {
        let count = totalVisibleSessionCount
        return "This will remove \(project.name) from xatlas and kill all \(count) terminal\(count == 1 ? "" : "s") plus their backing tmux session\(count == 1 ? "" : "s") everywhere."
    }

    var body: some View {
        let _ = state.terminalEventVersion

        VStack(spacing: 0) {
            // Draggable title bar
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
                    .onEnded { value in
                        dragAccumulated = dragOffset
                    }
            )

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(sessions) { session in
                        HStack(spacing: 6) {
                            Button {
                                selectedSessionID = session.id
                                state.setQuickViewSelectedSessionID(session.id, for: project.id)
                                requestTerminalFocus()
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
                            selectedSessionID = sessionID
                            state.setQuickViewSelectedSessionID(sessionID, for: project.id)
                            reconcileSessionState()
                            requestTerminalFocus()
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

            // Terminal area
            Group {
                if let sessionID = activeSessionID {
                    StyledTerminalView(
                        sessionID: sessionID,
                        appState: state,
                        focusToken: terminalFocusToken
                    )
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
        .onChange(of: state.terminalEventVersion) { _, _ in
            reconcileSessionState()
        }
        .onChange(of: activeSessionID) { _, sessionID in
            state.setQuickViewSelectedSessionID(sessionID, for: project.id)
            requestTerminalFocus()
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

    private func reconcileSessionState() {
        let liveSessionIDs = Set(allProjectSessions.map(\.id))
        sessionDisplayOrder.removeAll { !liveSessionIDs.contains($0) }
        sessionChipIdentities = sessionChipIdentities.filter { liveSessionIDs.contains($0.key) }

        let knownSessionIDs = Set(sessionDisplayOrder)
        sessionDisplayOrder.append(contentsOf: allProjectSessions
            .filter { !knownSessionIDs.contains($0.id) }
            .sorted(by: sessionCreationOrder)
            .map(\.id))
        reconcileSessionChipIdentities()

        if let selectedSessionID,
           sessions.contains(where: { $0.id == selectedSessionID }) {
            return
        }

        if let rememberedSessionID = state.quickViewSelectedSessionID(for: project.id),
           sessions.contains(where: { $0.id == rememberedSessionID }) {
            self.selectedSessionID = rememberedSessionID
            return
        }

        self.selectedSessionID = sessions.first?.id
        state.setQuickViewSelectedSessionID(self.selectedSessionID, for: project.id)
    }

    private func reconcileSessionChipIdentities() {
        for session in allProjectSessions.sorted(by: sessionCreationOrder) {
            let title = session.displayTitle
            if let existing = sessionChipIdentities[session.id],
               existing.baseTitle == title {
                continue
            }

            let ordinal = nextOrdinalByTitle[title] ?? 1
            sessionChipIdentities[session.id] = SessionChipIdentity(baseTitle: title, ordinal: ordinal)
            nextOrdinalByTitle[title] = ordinal + 1
        }
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

    private func sessionPriority(_ lhs: TerminalSession, _ rhs: TerminalSession) -> Bool {
        let lhsRank = rank(for: lhs)
        let rhsRank = rank(for: rhs)
        if lhsRank != rhsRank {
            return lhsRank < rhsRank
        }
        return lhs.updatedAt > rhs.updatedAt
    }

    private func sessionCreationOrder(_ lhs: TerminalSession, _ rhs: TerminalSession) -> Bool {
        if lhs.createdAt != rhs.createdAt {
            return lhs.createdAt < rhs.createdAt
        }
        if lhs.updatedAt != rhs.updatedAt {
            return lhs.updatedAt < rhs.updatedAt
        }
        return lhs.id < rhs.id
    }

    private func sessionChipTitle(for session: TerminalSession) -> String {
        let peers = sessions.filter { $0.displayTitle == session.displayTitle }
        guard peers.count > 1 else { return session.displayTitle }
        let ordinal = sessionChipIdentities[session.id]?.ordinal ?? 1
        return "\(session.displayTitle) \(ordinal)"
    }

    private func requestTerminalFocus() {
        terminalFocusToken &+= 1
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
            .frame(maxWidth: .infinity, minHeight: 200, maxHeight: 200)
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
