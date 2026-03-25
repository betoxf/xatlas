// FILE: XatlasRelayHomeView.swift
// Purpose: Remodex-aligned relay workspace surface for xatlas runtime connections.
// Layer: View
// Exports: XatlasRelayHomeView
// Depends on: SwiftUI, UIKit, CodexService, XatlasRelayService, TurnGitActionsToolbar

import SwiftUI
import UIKit

private let xatlasRelayActivitySectionID = "xatlas-relay-activity"

struct XatlasRelayHomeView: View {
    @Environment(CodexService.self) private var codex
    @State private var relay = XatlasRelayService()
    @State private var selectedSession: XatlasSession?
    @State private var showScanner = false
    @State private var dotPulse = false

    private let actionColumns = [
        GridItem(.flexible(minimum: 0, maximum: .infinity), spacing: 12),
        GridItem(.flexible(minimum: 0, maximum: .infinity), spacing: 12),
    ]

    private var activeSession: XatlasSession? {
        relay.sessions.first { $0.id == relay.selectedSessionId }
    }

    private var ungroupedSessions: [XatlasSession] {
        relay.sessions.filter { $0.projectId.isEmpty }
    }

    var body: some View {
        NavigationStack {
            Group {
                switch relay.connectionState {
                case .disconnected, .loading:
                    loadingState
                case .error(let message):
                    errorState(message: message)
                case .connected:
                    workspaceDashboard
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemGroupedBackground))
            .navigationTitle("xatlas")
            .navigationBarTitleDisplayMode(.inline)
        }
        .task(id: codex.isConnected && codex.isXatlasRuntime) {
            await relay.activate(codex: codex)
        }
        .onDisappear {
            relay.deactivate()
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView(
                onBack: { showScanner = false },
                onScan: { payload in
                    showScanner = false
                    Task {
                        await ContentViewModel().connectToRelay(pairingPayload: payload, codex: codex)
                    }
                }
            )
        }
        .sheet(item: $selectedSession) { session in
            XatlasRelayTerminalSheet(session: session, relay: relay)
                .environment(codex)
        }
    }

    private var loadingState: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 20) {
                appLogo
                statusCapsule(color: .orange, label: "Syncing relay workspace", pulsing: true)

                Text("Pulling projects, terminals, and recent operator activity from your Mac.")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }

            Spacer()
            Spacer()
        }
    }

    private func errorState(message: String) -> some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 20) {
                appLogo
                statusCapsule(color: .red, label: "Relay unavailable")

                Text(message)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)

                LazyVGrid(columns: actionColumns, spacing: 12) {
                    actionButton(
                        title: "Scan QR",
                        subtitle: "Pair a different relay",
                        tint: .blue
                    ) {
                        XatlasRuntimeGlyph(systemName: "qrcode.viewfinder", pointSize: 16)
                    } action: {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        showScanner = true
                    }

                    actionButton(
                        title: "Retry",
                        subtitle: "Refresh workspace state",
                        tint: .orange
                    ) {
                        XatlasRuntimeGlyph(actionKind: .syncNow, pointSize: 16)
                    } action: {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        Task { await relay.refreshWorkspaceState(codex: codex) }
                    }
                }
                .frame(maxWidth: 320)
            }

            Spacer()
            Spacer()
        }
        .padding(.horizontal, 24)
    }

    private var workspaceDashboard: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    heroCard

                    LazyVGrid(columns: actionColumns, spacing: 12) {
                        actionButton(
                            title: "Scan QR",
                            subtitle: "Reconnect another relay",
                            tint: .blue
                        ) {
                            XatlasRuntimeGlyph(systemName: "qrcode.viewfinder", pointSize: 16)
                        } action: {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            showScanner = true
                        }

                        actionButton(
                            title: "Sync",
                            subtitle: "Refresh projects and terminals",
                            tint: .green
                        ) {
                            XatlasRuntimeGlyph(actionKind: .syncNow, pointSize: 16)
                        } action: {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            Task { await relay.refreshWorkspaceState(codex: codex) }
                        }

                        actionButton(
                            title: "Activity",
                            subtitle: relay.operatorEvents.isEmpty ? "No recent operator events" : "Jump to recent work",
                            tint: .orange
                        ) {
                            XatlasRuntimeGlyph(actionKind: .commit, pointSize: 16)
                        } action: {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            withAnimation(.easeInOut(duration: 0.2)) {
                                proxy.scrollTo(xatlasRelayActivitySectionID, anchor: .top)
                            }
                        }

                        actionButton(
                            title: "Disconnect",
                            subtitle: "Return to pairing flow",
                            tint: .red
                        ) {
                            XatlasRuntimeGlyph(systemName: "power", pointSize: 15)
                        } action: {
                            HapticFeedback.shared.triggerImpactFeedback(style: .light)
                            Task { await codex.disconnect() }
                        }
                    }

                    if let activeSession {
                        selectedSessionCard(activeSession)
                    }

                    if !relay.operatorEvents.isEmpty {
                        activitySection
                            .id(xatlasRelayActivitySectionID)
                    }

                    ForEach(relay.projects) { project in
                        projectCard(project)
                    }

                    if !ungroupedSessions.isEmpty {
                        projectCard(title: "Other Terminals", path: nil, projectId: "", sessions: ungroupedSessions)
                    }

                    footerSummary
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .refreshable {
                await relay.refreshWorkspaceState(codex: codex)
            }
        }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 14) {
                appLogo

                VStack(alignment: .leading, spacing: 4) {
                    Text("Relay workspace")
                        .font(AppFont.title3(weight: .semibold))
                        .foregroundStyle(.primary)

                    Text("Browse xatlas projects, inspect active terminals, and review recent runtime activity without dropping into a raw CLI view.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)
            }

            HStack(spacing: 8) {
                statusCapsule(color: .green, label: "Connected")
                metricPill("\(relay.projects.count) projects")
                metricPill("\(relay.sessions.count) terminals")
                metricPill(relay.projectSurface.capitalized)
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }

    private func selectedSessionCard(_ session: XatlasSession) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(
                title: "Selected Terminal",
                subtitle: session.id,
                tint: .green
            ) {
                XatlasRuntimeGlyph(systemName: "terminal.fill", pointSize: 15)
            }

            sessionRow(session, isSelected: true)

            HStack(spacing: 10) {
                smallCapsuleButton("Open transcript") {
                    Task {
                        if !session.projectId.isEmpty {
                            await relay.selectProject(codex: codex, projectId: session.projectId)
                        }
                        await relay.selectSession(codex: codex, sessionId: session.id)
                        selectedSession = session
                    }
                }

                if session.attention {
                    smallCapsuleButton("Clear attention") {
                        Task {
                            _ = await relay.clearAttention(codex: codex, sessionId: session.id)
                            await relay.refreshWorkspaceState(codex: codex)
                        }
                    }
                }
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.green.opacity(0.18), lineWidth: 1)
        )
    }

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader(
                title: "Recent Activity",
                subtitle: "Operator events from the xatlas runtime",
                tint: .orange
            ) {
                XatlasRuntimeGlyph(actionKind: .commit, pointSize: 15)
            }

            ForEach(relay.operatorEvents.prefix(6)) { event in
                XatlasRelayActivityCard(
                    event: event,
                    onOpen: {
                        guard let session = relay.sessions.first(where: { $0.id == event.sessionId }) else {
                            return
                        }
                        Task {
                            if !session.projectId.isEmpty {
                                await relay.selectProject(codex: codex, projectId: session.projectId)
                            }
                            await relay.selectSession(codex: codex, sessionId: session.id)
                            selectedSession = session
                        }
                    },
                    onRetry: {
                        Task {
                            _ = await relay.retryLastCommand(codex: codex, sessionId: event.sessionId)
                            try? await Task.sleep(nanoseconds: 300_000_000)
                            await relay.refreshWorkspaceState(codex: codex)
                        }
                    }
                )
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }

    private func projectCard(_ project: XatlasProject) -> some View {
        projectCard(
            title: project.name,
            path: project.path,
            projectId: project.id,
            sessions: relay.sessionsForProject(project.id)
        )
    }

    private func projectCard(
        title: String,
        path: String?,
        projectId: String,
        sessions: [XatlasSession]
    ) -> some View {
        let isSelectedProject = !projectId.isEmpty && relay.selectedProjectId == projectId

        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill((isSelectedProject ? Color.blue : Color.primary).opacity(0.1))
                    XatlasRuntimeGlyph(systemName: "folder.fill", pointSize: 15)
                        .foregroundStyle(isSelectedProject ? Color.blue : Color.primary)
                }
                .frame(width: 34, height: 34)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(AppFont.headline(weight: .semibold))
                            .foregroundStyle(.primary)

                        if isSelectedProject {
                            metricPill("Selected")
                        }
                    }

                    if let path, !path.isEmpty {
                        Text(path)
                            .font(AppFont.mono(.caption2))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }

                Spacer(minLength: 0)

                metricPill("\(sessions.count)")
            }
            .padding(18)

            if sessions.isEmpty {
                HStack(spacing: 8) {
                    XatlasRuntimeGlyph(systemName: "terminal", pointSize: 12)
                        .foregroundStyle(.tertiary)
                    Text("No active terminals")
                        .font(AppFont.caption())
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 18)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                        if index > 0 {
                            Divider()
                                .padding(.leading, 64)
                        }

                        sessionRow(session, isSelected: session.id == relay.selectedSessionId)
                    }
                }
                .padding(.bottom, 6)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(isSelectedProject ? Color.blue.opacity(0.18) : Color.primary.opacity(0.06), lineWidth: 1)
        )
    }

    private func sessionRow(_ session: XatlasSession, isSelected: Bool) -> some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            Task {
                if !session.projectId.isEmpty {
                    await relay.selectProject(codex: codex, projectId: session.projectId)
                }
                await relay.selectSession(codex: codex, sessionId: session.id)
                selectedSession = session
            }
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(sessionTint(for: session).opacity(0.14))
                    Circle()
                        .fill(sessionTint(for: session))
                        .frame(width: 8, height: 8)
                }
                .frame(width: 28, height: 28)

                VStack(alignment: .leading, spacing: 3) {
                    Text(session.title)
                        .font(AppFont.subheadline(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    if !session.lastCommand.isEmpty {
                        Text("$ \(session.lastCommand)")
                            .font(AppFont.mono(.caption2))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    } else if !session.cwd.isEmpty {
                        Text(session.cwd)
                            .font(AppFont.mono(.caption2))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }

                Spacer(minLength: 0)

                sessionStatePill(session, isSelected: isSelected)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var footerSummary: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color.green)
                .frame(width: 6, height: 6)

            Text("xatlas relay connected and refreshing the workspace surface every few seconds.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
    }

    private func actionButton<Icon: View>(
        title: String,
        subtitle: String,
        tint: Color,
        @ViewBuilder icon: () -> Icon,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(tint.opacity(0.12))
                    icon()
                        .foregroundStyle(tint)
                }
                .frame(width: 38, height: 38)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(AppFont.subheadline(weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(AppFont.caption2())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.primary.opacity(0.06), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func sectionHeader<Icon: View>(
        title: String,
        subtitle: String,
        tint: Color,
        @ViewBuilder icon: () -> Icon
    ) -> some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(tint.opacity(0.12))
                icon()
                    .foregroundStyle(tint)
            }
            .frame(width: 32, height: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(AppFont.headline(weight: .semibold))
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)
        }
    }

    private func metricPill(_ label: String) -> some View {
        Text(label)
            .font(AppFont.caption(weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(Color(.tertiarySystemFill).opacity(0.85))
            )
    }

    private func sessionStatePill(_ session: XatlasSession, isSelected: Bool) -> some View {
        let tint = sessionTint(for: session)
        let label = isSelected ? "Selected" : session.state.capitalized

        return Text(label)
            .font(AppFont.caption2(weight: .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                Capsule()
                    .fill(tint.opacity(0.12))
            )
    }

    private func smallCapsuleButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    Capsule()
                        .fill(Color(.tertiarySystemFill).opacity(0.9))
                )
        }
        .buttonStyle(.plain)
    }

    private func sessionTint(for session: XatlasSession) -> Color {
        if session.attention {
            return .orange
        }

        switch session.state {
        case "idle":
            return .green
        case "running":
            return .blue
        case "error":
            return .red
        default:
            return Color.secondary
        }
    }

    private var appLogo: some View {
        Image("AppLogo")
            .resizable()
            .scaledToFit()
            .frame(width: 72, height: 72)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .adaptiveGlass(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func statusCapsule(color: Color, label: String, pulsing: Bool = false) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .scaleEffect(dotPulse && pulsing ? 1.4 : 1.0)
                .opacity(dotPulse && pulsing ? 0.6 : 1.0)
                .animation(
                    pulsing
                        ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true)
                        : .default,
                    value: dotPulse
                )

            Text(label)
                .font(AppFont.caption(weight: .medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(Capsule().fill(Color(.systemBackground)))
        .overlay(Capsule().stroke(Color.primary.opacity(0.08), lineWidth: 1))
        .onAppear { dotPulse = pulsing }
    }
}

private struct XatlasRuntimeGlyph: View {
    let uiImage: UIImage?
    let systemName: String?
    let pointSize: CGFloat

    init(actionKind: TurnGitActionKind, pointSize: CGFloat) {
        self.uiImage = actionKind.menuIcon(pointSize: pointSize)
        self.systemName = nil
        self.pointSize = pointSize
    }

    init(systemName: String, pointSize: CGFloat) {
        self.uiImage = nil
        self.systemName = systemName
        self.pointSize = pointSize
    }

    var body: some View {
        Group {
            if let uiImage {
                Image(uiImage: uiImage)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
            } else if let systemName {
                Image(systemName: systemName)
                    .font(.system(size: pointSize, weight: .semibold))
            }
        }
        .frame(width: pointSize, height: pointSize)
    }
}

private struct XatlasRelayActivityCard: View {
    let event: XatlasOperatorEvent
    let onOpen: () -> Void
    let onRetry: () -> Void

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    private var tint: Color {
        switch event.kind {
        case .commandStarted:
            return .blue
        case .commandFinished:
            return .green
        case .commandFailed:
            return .red
        }
    }

    private var title: String {
        switch event.kind {
        case .commandStarted:
            return "Command started"
        case .commandFinished:
            return "Command finished"
        case .commandFailed:
            return "Command failed"
        }
    }

    private var relativeTimestamp: String {
        guard let date = ISO8601DateFormatter().date(from: event.timestamp) else {
            return event.timestamp
        }
        return Self.relativeFormatter.localizedString(for: date, relativeTo: .now)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Circle()
                    .fill(tint)
                    .frame(width: 9, height: 9)
                    .padding(.top, 5)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(AppFont.subheadline(weight: .semibold))
                            .foregroundStyle(.primary)

                        if !event.projectName.isEmpty {
                            tag(text: event.projectName)
                        }

                        tag(text: event.sessionTitle)

                        Text(relativeTimestamp)
                            .font(AppFont.caption2(weight: .medium))
                            .foregroundStyle(.tertiary)
                    }

                    Text(event.command)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.primary.opacity(0.88))
                        .lineLimit(2)

                    if !event.details.isEmpty {
                        Text(event.details)
                            .font(AppFont.caption())
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                button("Open transcript", action: onOpen)
                button("Retry", action: onRetry)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.tertiarySystemFill).opacity(0.72))
        )
    }

    private func tag(text: String) -> some View {
        Text(text)
            .font(AppFont.caption2(weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .fill(Color(.systemBackground).opacity(0.8))
            )
    }

    private func button(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    Capsule()
                        .fill(Color(.systemBackground).opacity(0.8))
                )
        }
        .buttonStyle(.plain)
    }
}

private struct XatlasRelayTerminalSheet: View {
    let session: XatlasSession
    let relay: XatlasRelayService

    @Environment(CodexService.self) private var codex
    @Environment(\.dismiss) private var dismiss
    @State private var terminalOutput = ""
    @State private var commandText = ""
    @State private var isLoading = true
    @State private var refreshTask: Task<Void, Never>?

    private var transcriptSections: [XatlasTerminalSnapshotSection] {
        XatlasTerminalSnapshotFormatter.sections(from: terminalOutput)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    terminalHeaderCard

                    if isLoading && terminalOutput.isEmpty {
                        loadingCard
                    } else if terminalOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        emptyOutputCard
                    } else {
                        transcriptCard
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 20)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        dismiss()
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        Task { await loadSnapshot() }
                    } label: {
                        XatlasRuntimeGlyph(actionKind: .syncNow, pointSize: 16)
                            .foregroundStyle(.primary)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composerBar
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            await loadSnapshot()
            startAutoRefresh()
        }
        .onDisappear {
            refreshTask?.cancel()
            refreshTask = nil
        }
    }

    private var terminalHeaderCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(sessionTint.opacity(0.12))
                    XatlasRuntimeGlyph(systemName: "terminal.fill", pointSize: 16)
                        .foregroundStyle(sessionTint)
                }
                .frame(width: 38, height: 38)

                VStack(alignment: .leading, spacing: 3) {
                    Text(session.title)
                        .font(AppFont.subheadline(weight: .semibold))
                        .foregroundStyle(.primary)

                    if !session.cwd.isEmpty {
                        Text(session.cwd)
                            .font(AppFont.mono(.caption2))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }

                Spacer(minLength: 0)

                Text(session.state.capitalized)
                    .font(AppFont.caption2(weight: .semibold))
                    .foregroundStyle(sessionTint)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(
                        Capsule()
                            .fill(sessionTint.opacity(0.12))
                    )
            }

            if !session.lastCommand.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Last command")
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.secondary)

                    Text(session.lastCommand)
                        .font(AppFont.mono(.caption))
                        .foregroundStyle(.primary.opacity(0.9))
                        .textSelection(.enabled)
                }
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }

    private var loadingCard: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading terminal transcript…")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }

    private var emptyOutputCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("No transcript yet")
                .font(AppFont.subheadline(weight: .semibold))
                .foregroundStyle(.primary)

            Text("This terminal has not produced any visible output yet. Send a command below and the latest snapshot will render here in structured sections.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }

    private var transcriptCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                XatlasRuntimeGlyph(actionKind: .commit, pointSize: 15)
                    .foregroundStyle(.orange)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Live transcript")
                        .font(AppFont.subheadline(weight: .semibold))
                        .foregroundStyle(.primary)
                    Text("Formatted from the latest terminal snapshot so the screen reads more like a conversation surface than a raw pane dump.")
                        .font(AppFont.caption())
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(transcriptSections) { section in
                XatlasTerminalSectionView(section: section)
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }

    private var composerBar: some View {
        HStack(spacing: 10) {
            Text("$")
                .font(AppFont.mono(.subheadline))
                .foregroundStyle(.secondary)

            TextField("Send command to this terminal…", text: $commandText)
                .font(AppFont.mono(.subheadline))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit {
                    sendCommand()
                }

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                sendCommand()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(canSendCommand ? Color.primary : Color(.tertiaryLabel))
            }
            .buttonStyle(.plain)
            .disabled(!canSendCommand)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var canSendCommand: Bool {
        !commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var sessionTint: Color {
        switch session.state {
        case "idle":
            return .green
        case "running":
            return .blue
        case "error":
            return .red
        default:
            return Color.secondary
        }
    }

    private func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled else { return }
                await loadSnapshot()
            }
        }
    }

    private func loadSnapshot() async {
        isLoading = true
        terminalOutput = await relay.fetchSnapshot(codex: codex, sessionId: session.id) ?? terminalOutput
        isLoading = false
    }

    private func sendCommand() {
        let command = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            return
        }

        commandText = ""
        Task {
            _ = await relay.sendCommand(codex: codex, sessionId: session.id, command: command)
            try? await Task.sleep(nanoseconds: 400_000_000)
            await loadSnapshot()
            await relay.refreshWorkspaceState(codex: codex)
        }
    }
}

private enum XatlasTerminalSnapshotSectionStyle {
    case banner
    case prompt
    case note
    case body
}

private struct XatlasTerminalSnapshotSection: Identifiable, Equatable {
    let id: Int
    let style: XatlasTerminalSnapshotSectionStyle
    let text: String
}

private enum XatlasTerminalSnapshotFormatter {
    static func sections(from raw: String) -> [XatlasTerminalSnapshotSection] {
        let lines = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")

        var groups: [[String]] = []
        var current: [String] = []

        func flushCurrent() {
            guard !current.isEmpty else { return }
            groups.append(current)
            current.removeAll()
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || isSeparator(trimmed) {
                flushCurrent()
                continue
            }
            current.append(line)
        }
        flushCurrent()

        return groups.enumerated().map { index, group in
            let text = group.joined(separator: "\n")
            return XatlasTerminalSnapshotSection(
                id: index,
                style: classify(group),
                text: text
            )
        }
    }

    private static func classify(_ lines: [String]) -> XatlasTerminalSnapshotSectionStyle {
        let trimmedLines = lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let combined = trimmedLines.joined(separator: "\n")

        if trimmedLines.allSatisfy({ isPrompt($0) }) {
            return .prompt
        }

        if trimmedLines.count == 1,
           let line = trimmedLines.first,
           line.hasPrefix("⏵") || line.lowercased().contains("bypass permissions") {
            return .note
        }

        if combined.contains("Claude Code")
            || combined.contains("Codex")
            || combined.contains("Opus")
            || combined.contains("GPT")
            || combined.contains("context")
            || combined.contains("▐")
            || combined.contains("▝") {
            return .banner
        }

        return .body
    }

    private static func isPrompt(_ value: String) -> Bool {
        value.hasPrefix("❯")
            || value.hasPrefix("$")
            || value.hasPrefix(">")
            || value.hasPrefix(">>>")
    }

    private static func isSeparator(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        let separatorCharacters = CharacterSet(charactersIn: "─-_=•·")
        return value.unicodeScalars.allSatisfy(separatorCharacters.contains)
    }
}

private struct XatlasTerminalSectionView: View {
    let section: XatlasTerminalSnapshotSection

    var body: some View {
        switch section.style {
        case .banner:
            sectionCard(
                label: "Runtime",
                tint: .blue,
                background: Color(.tertiarySystemFill).opacity(0.82),
                foreground: .primary
            )
        case .prompt:
            sectionCard(
                label: "Prompt",
                tint: .green,
                background: Color.green.opacity(0.1),
                foreground: .primary
            )
        case .note:
            sectionCard(
                label: "Note",
                tint: .orange,
                background: Color.orange.opacity(0.1),
                foreground: Color.secondary
            )
        case .body:
            sectionCard(
                label: "Output",
                tint: Color.secondary,
                background: Color(.tertiarySystemFill).opacity(0.72),
                foreground: .primary
            )
        }
    }

    private func sectionCard(
        label: String,
        tint: Color,
        background: Color,
        foreground: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label.uppercased())
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(tint)

            Text(section.text)
                .font(AppFont.mono(.caption))
                .foregroundStyle(foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(background)
        )
    }
}
