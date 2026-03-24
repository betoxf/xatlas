import SwiftUI

struct WorkspaceSectionView: View {
    @Bindable var state: AppState
    @State private var snapshot = AgentCatalogSnapshot(mcpServers: [], skills: [], automations: [], availableProviders: [])
    @State private var isMCPComposerPresented = false
    @State private var operatorVersion = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header

                switch state.selectedSection {
                case .projects:
                    EmptyView()
                case .mcp:
                    catalogSection(
                        title: "MCP Servers",
                        subtitle: "Global, project, and plugin-provided servers discovered from Codex, Claude, and .mcp.json",
                        count: snapshot.mcpServers.count
                    ) {
                        ForEach(snapshot.mcpServers) { server in
                            MCPServerRow(record: server, snapshot: snapshot, state: state, refresh: refresh)
                        }
                    }
                case .skills:
                    catalogSection(
                        title: "Skills",
                        subtitle: "Codex skills, Claude skills, and plugin-provided skill packs discovered from config and local folders",
                        count: snapshot.skills.count
                    ) {
                        ForEach(snapshot.skills) { skill in
                            SkillRow(record: skill, state: state, refresh: refresh)
                        }
                    }
                case .automations:
                    operatorSection
                    catalogSection(
                        title: "Automations",
                        subtitle: "Claude commands, agents, and hooks discovered from user, project, and plugin installs",
                        count: snapshot.automations.count
                    ) {
                        ForEach(snapshot.automations) { automation in
                            AutomationRow(record: automation, state: state, refresh: refresh)
                        }
                    }
                }
            }
            .padding(18)
        }
        .onAppear(perform: refresh)
        .onChange(of: state.selectedSection) { _, _ in refresh() }
        .onChange(of: state.selectedProject?.id) { _, _ in refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .xatlasTerminalSessionDidChange)) { _ in
            operatorVersion &+= 1
        }
        .sheet(isPresented: $isMCPComposerPresented) {
            MCPComposerView(projectPath: state.selectedProject?.path, refresh: refresh)
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text(state.selectedSection.title)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.primary)

                if let selectedProject = state.selectedProject {
                    Text("Context: \(selectedProject.name)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            HStack(spacing: 8) {
                if state.selectedSection == .mcp {
                    Button("Add MCP") {
                        isMCPComposerPresented = true
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(.white.opacity(0.55)))
                }

                ForEach(quickActions) { action in
                    Button(action.title) {
                        action.handler()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(.white.opacity(0.45)))
                }

                Button(action: refresh) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    Capsule()
                        .fill(.white.opacity(0.45))
                )
            }
        }
    }

    private func catalogSection<Content: View>(
        title: String,
        subtitle: String,
        count: Int,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                Text("\(count)")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(.white.opacity(0.5)))
            }

            Text(subtitle)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)

            VStack(spacing: 10) {
                content()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func refresh() {
        snapshot = AgentCatalogService.shared.snapshot(projectPath: state.selectedProject?.path)
    }

    @ViewBuilder
    private var operatorSection: some View {
        let events = OperatorEventStore.shared.recentEvents(limit: 12)

        catalogSection(
            title: "Operator Feed",
            subtitle: "Cross-project command starts, completions, and failures collected from the terminals inside xatlas",
            count: events.count
        ) {
            VStack(spacing: 10) {
                OperatorSummaryRow(
                    runningCount: TerminalService.shared.sessions.filter { $0.activityState == .running }.count,
                    attentionCount: TerminalService.shared.sessions.filter(\.requiresAttention).count,
                    projectCount: Set(TerminalService.shared.sessions.compactMap(\.projectID)).count
                )

                if events.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No operator events yet.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(.white.opacity(0.38))
                    )
                } else {
                    ForEach(events) { event in
                        OperatorEventRow(
                            event: event,
                            projectName: state.projects.first(where: { $0.id == event.projectID })?.name,
                            state: state
                        )
                    }
                }
            }
        }
    }

    private var quickActions: [CatalogQuickAction] {
        let home = NSHomeDirectory()
        switch state.selectedSection {
        case .projects:
            return []
        case .mcp:
            var actions = [
                CatalogQuickAction(title: "Codex Config") {
                    state.openTextFile(path: home + "/.codex/config.toml", initialContent: "# Codex config\n")
                },
                CatalogQuickAction(title: "Claude Settings") {
                    state.openTextFile(path: home + "/.claude/settings.json", initialContent: "{\n  \"mcpServers\": {}\n}\n")
                }
            ]
            if let projectPath = state.selectedProject?.path {
                actions.append(
                    CatalogQuickAction(title: "Project Codex Config") {
                        state.openTextFile(
                            path: projectPath + "/.codex/config.toml",
                            initialContent: "# Project Codex overrides\n"
                        )
                    }
                )
                actions.append(
                    CatalogQuickAction(title: "Project .mcp.json") {
                        state.openTextFile(
                            path: projectPath + "/.mcp.json",
                            initialContent: "{\n  \"mcpServers\": {}\n}\n"
                        )
                    }
                )
            }
            return actions
        case .skills:
            var actions = [
                CatalogQuickAction(title: "Codex Skills") {
                    state.revealInFinder(path: home + "/.codex/skills", createIfMissing: true, isDirectory: true)
                },
                CatalogQuickAction(title: "Claude Skills") {
                    state.revealInFinder(path: home + "/.claude/skills", createIfMissing: true, isDirectory: true)
                },
                CatalogQuickAction(title: "Claude Plugins") {
                    state.revealInFinder(path: home + "/.claude/plugins", createIfMissing: true, isDirectory: true)
                }
            ]
            if let projectPath = state.selectedProject?.path {
                actions.append(
                    CatalogQuickAction(title: "Project Skills") {
                        state.revealInFinder(path: projectPath + "/.claude/skills", createIfMissing: true, isDirectory: true)
                    }
                )
            }
            return actions
        case .automations:
            var actions = [
                CatalogQuickAction(title: "Claude Commands") {
                    state.revealInFinder(path: home + "/.claude/commands", createIfMissing: true, isDirectory: true)
                },
                CatalogQuickAction(title: "Claude Agents") {
                    state.revealInFinder(path: home + "/.claude/agents", createIfMissing: true, isDirectory: true)
                },
                CatalogQuickAction(title: "Claude Settings") {
                    state.openTextFile(path: home + "/.claude/settings.json", initialContent: "{\n  \"hooks\": {}\n}\n")
                }
            ]
            if let projectPath = state.selectedProject?.path {
                actions.append(
                    CatalogQuickAction(title: "Project Commands") {
                        state.revealInFinder(path: projectPath + "/.claude/commands", createIfMissing: true, isDirectory: true)
                    }
                )
                actions.append(
                    CatalogQuickAction(title: "Project Agents") {
                        state.revealInFinder(path: projectPath + "/.claude/agents", createIfMissing: true, isDirectory: true)
                    }
                )
            }
            return actions
        }
    }
}

private struct OperatorSummaryRow: View {
    let runningCount: Int
    let attentionCount: Int
    let projectCount: Int

    var body: some View {
        HStack(spacing: 8) {
            ScopeBadge(text: "\(runningCount) running")
            ScopeBadge(text: "\(attentionCount) attention")
            ScopeBadge(text: "\(projectCount) projects")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct OperatorEventRow: View {
    let event: OperatorEvent
    let projectName: String?
    @Bindable var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Circle()
                    .fill(tint)
                    .frame(width: 9, height: 9)
                    .padding(.top, 5)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(.system(size: 13, weight: .semibold))
                        ScopeBadge(text: projectName ?? "Global")
                        ScopeBadge(text: event.sessionTitle)
                        Text(relativeTime)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }

                    Text(event.command)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(.primary.opacity(0.82))
                        .lineLimit(2)

                    if let details = event.details, !details.isEmpty {
                        Text(details)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }

                Spacer()
            }

            HStack(spacing: 8) {
                Button("Open Terminal") {
                    _ = state.openTerminalSession(event.sessionID)
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(.white.opacity(0.36)))

                Button("Retry") {
                    _ = state.retryLastCommand(for: event.sessionID)
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(.white.opacity(0.36)))

                Button("Clear Attention") {
                    _ = state.clearAttention(for: event.sessionID)
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(.white.opacity(0.36)))
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.white.opacity(0.5))
        )
    }

    private var title: String {
        switch event.kind {
        case .commandStarted:
            return "Started"
        case .commandFinished:
            return "Finished"
        case .commandFailed:
            return "Failed"
        }
    }

    private var tint: Color {
        switch event.kind {
        case .commandStarted:
            return .blue.opacity(0.75)
        case .commandFinished:
            return .green.opacity(0.78)
        case .commandFailed:
            return .red.opacity(0.8)
        }
    }

    private var relativeTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: event.timestamp, relativeTo: .now)
    }
}

private struct CatalogQuickAction: Identifiable {
    let id = UUID()
    let title: String
    let handler: () -> Void
}

private struct MCPServerRow: View {
    let record: MCPServerRecord
    let snapshot: AgentCatalogSnapshot
    @Bindable var state: AppState
    let refresh: () -> Void

    var body: some View {
        let extraActions: [CardAction] = record.origin == .plugin ? [] : [
            CardAction(title: "Delete", role: .destructive) {
                _ = AgentCatalogService.shared.deleteMCP(record)
                refresh()
            }
        ]

        CatalogCard(
            state: state,
            sourcePath: record.sourcePath,
            extraActions: extraActions
        ) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(record.name)
                            .font(.system(size: 13, weight: .semibold))
                        ScopeBadge(text: record.provider.label)
                        ScopeBadge(text: record.scope.label)
                        ScopeBadge(text: record.transportSummary)
                    }
                    Text(record.detailSummary)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    providerBadges
                    SourcePathLabel(path: record.sourcePath)
                }
                Spacer()
            }
        }
    }

    private var providerBadges: some View {
        HStack(spacing: 8) {
            Text("Providers")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            ForEach(snapshot.availableProviders) { availability in
                let client = availability.client
                let isActive = snapshot.mcpServers.contains { candidate in
                    candidate.name == record.name && matches(candidate.provider, client: client)
                }
                let canAdd = availability.isInstalled && client.supportsManagedMCP && !isActive

                Button {
                    guard canAdd else { return }
                    _ = AgentCatalogService.shared.copyMCP(record, to: client)
                    refresh()
                } label: {
                    Text(client.label)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(foregroundColor(isActive: isActive, availability: availability, canAdd: canAdd))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(
                            Capsule().fill(backgroundColor(isActive: isActive, availability: availability, canAdd: canAdd))
                        )
                        .overlay(
                            Capsule().stroke(borderColor(isActive: isActive, availability: availability, canAdd: canAdd), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .disabled(!canAdd)
            }
        }
    }

    private func matches(_ provider: CatalogProvider, client: ProviderClient) -> Bool {
        switch (provider, client) {
        case (.codex, .codex), (.claude, .claude):
            return true
        default:
            return false
        }
    }

    private func foregroundColor(isActive: Bool, availability: ProviderAvailability, canAdd: Bool) -> Color {
        if isActive { return .white }
        if canAdd { return .primary.opacity(0.65) }
        return .primary.opacity(0.28)
    }

    private func backgroundColor(isActive: Bool, availability: ProviderAvailability, canAdd: Bool) -> Color {
        if isActive { return Color.accentColor.opacity(0.9) }
        if canAdd { return .white.opacity(0.36) }
        return availability.isInstalled ? .white.opacity(0.16) : .white.opacity(0.08)
    }

    private func borderColor(isActive: Bool, availability: ProviderAvailability, canAdd: Bool) -> Color {
        if isActive { return .clear }
        if canAdd { return .white.opacity(0.25) }
        return .white.opacity(0.12)
    }
}

private struct SkillRow: View {
    let record: SkillRecord
    @Bindable var state: AppState
    let refresh: () -> Void

    var body: some View {
        let extraActions: [CardAction] = record.origin == .folder ? [
            CardAction(title: "Delete", role: .destructive) {
                _ = AgentCatalogService.shared.deleteSkill(record)
                refresh()
            }
        ] : []

        CatalogCard(
            state: state,
            sourcePath: record.sourcePath,
            extraActions: extraActions
        ) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(record.name)
                            .font(.system(size: 13, weight: .semibold))
                        ScopeBadge(text: record.provider.label)
                        ScopeBadge(text: record.scope.label)
                        ScopeBadge(text: record.category)
                    }
                    Text(record.detailSummary)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    SourcePathLabel(path: record.sourcePath)
                }
                Spacer()
            }
        }
    }
}

private struct AutomationRow: View {
    let record: AutomationRecord
    @Bindable var state: AppState
    let refresh: () -> Void

    var body: some View {
        let extraActions: [CardAction] = record.origin == .folder ? [
            CardAction(title: "Delete", role: .destructive) {
                _ = AgentCatalogService.shared.deleteAutomation(record)
                refresh()
            }
        ] : []

        CatalogCard(
            state: state,
            sourcePath: record.sourcePath,
            extraActions: extraActions
        ) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(record.name)
                            .font(.system(size: 13, weight: .semibold))
                        ScopeBadge(text: record.provider.label)
                        ScopeBadge(text: record.scope.label)
                        ScopeBadge(text: record.category)
                    }
                    Text(record.detailSummary)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    SourcePathLabel(path: record.sourcePath)
                }
                Spacer()
            }
        }
    }
}

private struct CatalogCard<Content: View>: View {
    @Bindable var state: AppState
    let sourcePath: String
    let extraActions: [CardAction]
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content

            HStack {
                ForEach(extraActions) { action in
                    Button(action.title) {
                        action.handler()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(action.role == .destructive ? .red.opacity(0.75) : .primary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(
                        Capsule().fill(.white.opacity(0.32))
                    )
                }

                Spacer()
                Button("Open Source") {
                    state.openTextFile(path: sourcePath)
                }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    Capsule().fill(.white.opacity(0.5))
                )
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.white.opacity(0.38))
        )
    }
}

private struct CardAction: Identifiable {
    enum Role {
        case normal
        case destructive
    }

    let id = UUID()
    let title: String
    var role: Role = .normal
    let handler: () -> Void
}

private struct ScopeBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .foregroundStyle(.primary.opacity(0.65))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Capsule().fill(.white.opacity(0.5)))
    }
}

private struct SourcePathLabel: View {
    let path: String

    var body: some View {
        Text(path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(.primary.opacity(0.4))
            .lineLimit(1)
    }
}
