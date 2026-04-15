import SwiftUI

/// Shared card chrome used by MCPServerRow / SkillRow / AutomationRow.
/// Wraps caller-provided content in a section surface and appends a
/// row of trailing actions plus an "Open Source" shortcut.
struct CatalogCard<Content: View>: View {
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
        .xatlasSectionSurface()
    }
}

/// One trailing action on a CatalogCard. `destructive` role tints the
/// label red but does not gate the handler — callers wire confirmation
/// dialogs themselves where needed.
struct CardAction: Identifiable {
    enum Role {
        case normal
        case destructive
    }

    let id = UUID()
    let title: String
    var role: Role = .normal
    let handler: () -> Void
}
