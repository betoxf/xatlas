import AppKit
import SwiftUI

struct ProjectDashboardView: View {
    @Bindable var state: AppState
    @State private var operatorService = ProjectOperatorService.shared
    @State private var operatorInput = ""
    @State private var isOperatorCollapsed = false
    @FocusState private var isOperatorFocused: Bool

    private let columns = [
        GridItem(.adaptive(minimum: 214, maximum: 258), spacing: 16, alignment: .top)
    ]

    private var filteredProjects: [Project] {
        let query = state.dashboardSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return state.projects }
        return state.projects.filter { $0.name.lowercased().contains(query) }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 16) {
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
                .padding(18)
                .padding(.bottom, isOperatorCollapsed ? 84 : 198)
            }
            .simultaneousGesture(
                TapGesture().onEnded {
                    activateOperatorInput()
                }
            )

            DashboardOperatorOverlay(
                messages: Array(operatorService.consoleMessages.suffix(6)),
                isReady: operatorService.isGlobalOperatorReady,
                input: $operatorInput,
                isCollapsed: $isOperatorCollapsed,
                isFocused: $isOperatorFocused,
                addProject: state.presentProjectPicker,
                send: sendOperatorMessage,
                activateInput: activateOperatorInput
            )
            .padding(.horizontal, 22)
            .padding(.bottom, 14)
        }
        .onAppear {
            activateOperatorInput()
        }
    }

    private func sendOperatorMessage() {
        let trimmed = operatorInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = operatorService.sendConsoleMessage(trimmed, preferredProject: nil)
        operatorInput = ""
        activateOperatorInput()
    }

    private func activateOperatorInput() {
        guard !isOperatorCollapsed else { return }
        isOperatorFocused = true
    }

}

private struct ProjectDashboardCard: View {
    let project: Project
    @Bindable var state: AppState
    let onQuickView: () -> Void

    @State private var previewText = "No terminal output yet."
    @State private var isHovered = false
    @State private var previewHistoryBySessionID: [String: String] = [:]
    @State private var previewSessionID: String?
    private let previewTimer = Timer.publish(every: 1.1, on: .main, in: .common).autoconnect()

    private var allSessions: [TerminalSession] {
        TerminalService.shared.liveSessionsForProject(project.id)
    }

    private var primarySession: TerminalSession? {
        if let previewSessionID,
           let matchingSession = allSessions.first(where: { $0.id == previewSessionID }) {
            return matchingSession
        }
        return preferredPreviewSession()
    }

    private var attentionCount: Int {
        state.projectAttentionCount(project.id)
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
                            .font(.system(size: 16, weight: .semibold))
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
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary.opacity(0.55))
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(previewIndicatorColor)
                        .frame(width: 6, height: 6)

                    Text("Live Preview")
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                }

                Text(previewText)
                    .font(.system(size: 6.9, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.72))
                    .lineSpacing(0)
                    .frame(maxWidth: .infinity, minHeight: 42, maxHeight: 42, alignment: .topLeading)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .clipped()
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.black.opacity(0.04))
            )
        }
        .padding(15)
        .frame(maxWidth: .infinity, minHeight: 174, maxHeight: 174, alignment: .topLeading)
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
            syncPreviewSessionSelection()
            refreshPreview()
        }
        .onChange(of: state.terminalEventVersion) { _, _ in
            syncPreviewSessionSelection()
            refreshPreview()
        }
        .onReceive(previewTimer) { _ in
            guard primarySession != nil else { return }
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

    private var previewIndicatorColor: Color {
        guard let primarySession else { return .secondary.opacity(0.45) }
        switch primarySession.activityState {
        case .running:
            return .green.opacity(0.82)
        case .idle:
            return .blue.opacity(0.72)
        case .detached:
            return .orange.opacity(0.76)
        case .error:
            return .red.opacity(0.78)
        case .exited:
            return .secondary.opacity(0.45)
        }
    }

    private func refreshPreview() {
        guard let session = primarySession else {
            previewText = "Starting terminal…"
            return
        }

        guard let snapshot = TerminalService.shared.snapshot(for: session.id, lines: 18) else {
            previewText = DashboardPreviewFormatter.fallback(for: session)
            return
        }

        guard let nextPreview = DashboardPreviewFormatter.preview(from: snapshot) else {
            if let rememberedPreview = previewHistoryBySessionID[session.id], !rememberedPreview.isEmpty {
                previewText = rememberedPreview
                return
            }
            previewText = DashboardPreviewFormatter.fallback(for: session)
            return
        }

        previewHistoryBySessionID[session.id] = nextPreview
        previewText = nextPreview
    }

    private func syncPreviewSessionSelection() {
        if let quickViewSessionID = state.quickViewSelectedSessionID(for: project.id),
           containsSession(id: quickViewSessionID) {
            previewSessionID = quickViewSessionID
            return
        }

        if state.selectedProject?.id == project.id,
           case .terminal(let sessionID) = state.selectedTab?.kind,
           containsSession(id: sessionID) {
            previewSessionID = sessionID
            return
        }

        if let previewSessionID, containsSession(id: previewSessionID) {
            return
        }

        previewSessionID = preferredPreviewSession()?.id
    }

    private func containsSession(id: String) -> Bool {
        allSessions.contains(where: { $0.id == id })
    }

    private func preferredPreviewSession() -> TerminalSession? {
        allSessions.max(by: TerminalSession.recencyOrder)
    }

}

private enum DashboardPreviewFormatter {
    static func preview(from snapshot: String) -> String? {
        let lines = snapshot
            .components(separatedBy: .newlines)
            .map { $0.replacingOccurrences(of: "\t", with: "    ") }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .filter { !$0.allSatisfy { $0 == "─" || $0 == "_" || $0 == "-" || $0 == "·" } }
            .filter { !isPromptLike($0) }
            .map(compact)

        guard !lines.isEmpty else { return nil }
        return lines.suffix(6).joined(separator: "\n")
    }

    static func fallback(for session: TerminalSession) -> String {
        let directory = session.displayDirectory
        let lastCommand = session.lastCommand.map(compact)

        switch session.activityState {
        case .running:
            if let lastCommand {
                return "Running in \(directory)\n\(lastCommand)"
            }
            return "Running in \(directory)\nStreaming terminal output…"
        case .idle, .detached:
            if let lastCommand {
                return "Shell ready in \(directory)\nLast command: \(lastCommand)"
            }
            return "Shell ready in \(directory)\nWaiting for command…"
        case .error:
            return "Terminal unavailable\nCouldn't attach a tmux session."
        case .exited:
            return "Terminal closed\nOpen a new terminal to resume."
        }
    }

    private static func compact(_ line: String) -> String {
        let collapsed = line.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        if collapsed.count > 42 {
            return String(collapsed.prefix(42)) + "…"
        }
        return collapsed
    }

    private static func isPromptLike(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return true
        }
        if trimmed == ">" || trimmed.hasPrefix("> ") || trimmed.hasPrefix("› ") {
            return true
        }
        if trimmed.hasSuffix("$") || trimmed.hasSuffix("%") || trimmed.hasSuffix("#") {
            return true
        }
        return trimmed.contains("❯")
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
    let activateInput: () -> Void
    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if isCollapsed {
                collapsedDock
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
                if !messages.isEmpty {
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(messages) { message in
                                OperatorBubble(message: message)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                    }
                    .frame(maxHeight: 132)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 2)
                }

                VStack(alignment: .leading, spacing: 10) {
                    operatorHandle

                    HStack(alignment: .bottom, spacing: 10) {
                        Button(action: addProject) {
                            Image(systemName: "plus")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(.primary.opacity(0.58))
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
                                    expandTray()
                                } else {
                                    activateInput()
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
                        .stroke(.white.opacity(isInteractive ? 0.8 : 0.62), lineWidth: 1)
                )
                .shadow(color: .black.opacity(isInteractive ? 0.10 : 0.06), radius: isInteractive ? 18 : 12, y: 5)
                .shadow(color: .white.opacity(isInteractive ? 0.28 : 0.18), radius: 8, y: -2)
                .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .onTapGesture {
                    activateInput()
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity, alignment: .center)
        .onHover { isHovered = $0 }
        .animation(.spring(response: 0.3, dampingFraction: 0.86), value: isCollapsed)
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
            .fill(Color.white.opacity(isInteractive ? 0.97 : 0.91))
    }

    private var operatorHandle: some View {
        Capsule()
            .fill(Color.black.opacity(0.14))
            .frame(width: 48, height: 5)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .onTapGesture {
                collapseTray()
            }
            .gesture(
                DragGesture(minimumDistance: 8)
                    .onEnded { value in
                        if value.translation.height > 18 {
                            collapseTray()
                        } else if value.translation.height < -18 {
                            expandTray()
                        }
                    }
            )
    }

    private var collapsedDock: some View {
        Button(action: expandTray) {
            Capsule()
                .fill(Color.black.opacity(0.16))
                .frame(width: 42, height: 5)
                .frame(width: 78, height: 24)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.white.opacity(0.78))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(.white.opacity(0.56), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.06), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
    }

    private func collapseTray() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) {
            isCollapsed = true
        }
        isFocused.wrappedValue = false
    }

    private func expandTray() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) {
            isCollapsed = false
        }
        DispatchQueue.main.async {
            activateInput()
        }
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
        TerminalService.shared.liveSessionsForProject(project.id)
    }

    private var visibleSessions: [TerminalSession] {
        if showAllSessions {
            return allProjectSessions.sorted(by: TerminalSession.priorityOrder)
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
        return TerminalService.shared.hiddenSessionCountForProject(project.id, maxDetached: 6)
    }

    private var totalVisibleSessionCount: Int {
        state.projectLiveSessionCount(project.id)
    }

    private var projectCloseWarningText: String {
        state.projectCloseWarningText(for: project)
    }

    var body: some View {
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

    private func reconcileSessionState() {
        let liveSessionIDs = Set(allProjectSessions.map(\.id))
        sessionDisplayOrder.removeAll { !liveSessionIDs.contains($0) }
        sessionChipIdentities = sessionChipIdentities.filter { liveSessionIDs.contains($0.key) }

        let knownSessionIDs = Set(sessionDisplayOrder)
        sessionDisplayOrder.append(contentsOf: allProjectSessions
            .filter { !knownSessionIDs.contains($0.id) }
            .sorted(by: TerminalSession.creationOrder)
            .map(\.id))
        reconcileSessionChipIdentities()

        if let selectedSessionID,
           sessions.contains(where: { $0.id == selectedSessionID }) {
            return
        }

        if let rememberedSessionID = state.quickViewSelectedSessionID(for: project.id),
           sessions.contains(where: { $0.id == rememberedSessionID }) {
            selectSession(rememberedSessionID)
            return
        }

        selectSession(sessions.first?.id)
    }

    private func reconcileSessionChipIdentities() {
        for session in allProjectSessions.sorted(by: TerminalSession.creationOrder) {
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

    private func sessionChipTitle(for session: TerminalSession) -> String {
        let peers = sessions.filter { $0.displayTitle == session.displayTitle }
        guard peers.count > 1 else { return session.displayTitle }
        let ordinal = sessionChipIdentities[session.id]?.ordinal ?? 1
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

private struct AddProjectTile: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 12) {
                Image(systemName: "plus")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(.secondary.opacity(0.8))
                Text("Add Project")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 174, maxHeight: 174)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [7, 7]))
                    .foregroundStyle(.secondary.opacity(isHovered ? 0.45 : 0.25))
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}
