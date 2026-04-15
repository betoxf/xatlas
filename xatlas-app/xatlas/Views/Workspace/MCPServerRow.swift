import SwiftUI

/// One MCP server entry rendered in the workspace catalog. Shows the
/// server's name + transport summary + per-provider install pills that
/// let the user copy the entry to other supported clients.
struct MCPServerRow: View {
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
