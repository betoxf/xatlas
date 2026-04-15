import SwiftUI

/// The non-projects workspace surface — renders the MCP / Skills /
/// Automations catalog sections plus the operator feed. Reads its data
/// from AgentCatalogService and re-fetches when the active section or
/// project changes.
struct WorkspaceSectionView: View {
    @Bindable var state: AppState
    @State private var snapshot = AgentCatalogSnapshot(mcpServers: [], skills: [], automations: [], availableProviders: [])
    @State private var isMCPComposerPresented = false
    @State private var operatorVersion = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
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
            .padding(20)
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
                    .background(
                        RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                            .fill(.white.opacity(0.55))
                    )
                }

                ForEach(quickActions) { action in
                    Button(action.title) {
                        action.handler()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                            .fill(.white.opacity(0.45))
                    )
                }

                Button(action: refresh) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
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
        .padding(16)
        .xatlasSectionSurface(fill: .white.opacity(0.28), stroke: .white.opacity(0.26))
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

/// One labeled action shown in the workspace header. Identifiable so we
/// can drive ForEach without re-keying.
private struct CatalogQuickAction: Identifiable {
    let id = UUID()
    let title: String
    let handler: () -> Void
}
