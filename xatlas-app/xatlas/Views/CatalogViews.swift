import SwiftUI

struct WorkspaceSectionView: View {
    @Bindable var state: AppState
    @State private var snapshot = AgentCatalogSnapshot(mcpServers: [], skills: [], automations: [], availableProviders: [])

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
                        subtitle: "Global and project-scoped servers discovered from Codex, Claude, and .mcp.json",
                        count: snapshot.mcpServers.count
                    ) {
                        ForEach(snapshot.mcpServers) { server in
                            MCPServerRow(record: server, snapshot: snapshot, state: state, refresh: refresh)
                        }
                    }
                case .skills:
                    catalogSection(
                        title: "Skills",
                        subtitle: "Reusable skill packs discovered from user and project folders",
                        count: snapshot.skills.count
                    ) {
                        ForEach(snapshot.skills) { skill in
                            SkillRow(record: skill, state: state, refresh: refresh)
                        }
                    }
                case .automations:
                    catalogSection(
                        title: "Automations",
                        subtitle: "Claude custom commands and project-level automation entry points",
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
                }
            ]
            if let projectPath = state.selectedProject?.path {
                actions.append(
                    CatalogQuickAction(title: "Project Commands") {
                        state.revealInFinder(path: projectPath + "/.claude/commands", createIfMissing: true, isDirectory: true)
                    }
                )
            }
            return actions
        }
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
        CatalogCard(
            state: state,
            sourcePath: record.sourcePath,
            extraActions: [
                CardAction(title: "Delete", role: .destructive) {
                    _ = AgentCatalogService.shared.deleteMCP(record)
                    refresh()
                }
            ]
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
        CatalogCard(
            state: state,
            sourcePath: record.sourcePath,
            extraActions: [
                CardAction(title: "Delete", role: .destructive) {
                    _ = AgentCatalogService.shared.deleteSkill(record)
                    refresh()
                }
            ]
        ) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(record.name)
                            .font(.system(size: 13, weight: .semibold))
                        ScopeBadge(text: record.provider.label)
                        ScopeBadge(text: record.scope.label)
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
        CatalogCard(
            state: state,
            sourcePath: record.sourcePath,
            extraActions: [
                CardAction(title: "Delete", role: .destructive) {
                    _ = AgentCatalogService.shared.deleteAutomation(record)
                    refresh()
                }
            ]
        ) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(record.name)
                            .font(.system(size: 13, weight: .semibold))
                        ScopeBadge(text: record.provider.label)
                        ScopeBadge(text: record.scope.label)
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
