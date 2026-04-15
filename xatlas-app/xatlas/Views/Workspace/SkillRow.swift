import SwiftUI

/// One skill entry rendered in the workspace catalog. Folder-origin
/// skills get a Delete action; config-origin skills don't.
struct SkillRow: View {
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
