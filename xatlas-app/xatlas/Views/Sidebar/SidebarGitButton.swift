import SwiftUI

/// Inline git status pill shown on a sidebar project row when the repo
/// has uncommitted changes. Tap to AI-sync; right-click for branch ops.
struct SidebarGitButton: View {
    let status: GitStatus
    let isSelected: Bool
    let isSyncing: Bool
    let onSync: () -> Void
    let onRefresh: () -> Void
    let projectPath: String
    @State private var isGitHovered = false
    @State private var remoteURL: String?

    private enum GitCommand: Sendable {
        case pull
        case push
        case fetch
    }

    private var changeCount: Int { status.changes.count }

    var body: some View {
        Button(action: onSync) {
            HStack(spacing: 3) {
                if isSyncing {
                    ProgressView()
                        .controlSize(.mini)
                        .scaleEffect(0.6)
                } else {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 10, weight: .medium))
                }

                Text("\(changeCount)")
                    .font(XatlasFont.badge)
            }
            .foregroundStyle(badgeColor)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(
                Capsule()
                    .fill(badgeBgColor)
                    .overlay(
                        Capsule()
                            .strokeBorder(badgeColor.opacity(0.18), lineWidth: 0.5)
                    )
            )
            .scaleEffect(isGitHovered ? 1.1 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { isGitHovered = $0 }
        .animation(XatlasMotion.hover, value: isGitHovered)
        .xatlasPressEffect(scale: 0.92)
        .onAppear { refreshRemoteURL() }
        .help("Commit & push \(changeCount) change\(changeCount == 1 ? "" : "s")")
        .contextMenu {
            Label(status.branch, systemImage: "arrow.triangle.branch")
                .font(.headline)
            Divider()
            Button {
                onSync()
            } label: {
                Label("AI Sync", systemImage: "sparkles")
            }
            Button {
                runGitAction(.pull)
            } label: {
                Label("Pull", systemImage: "arrow.down")
            }
            Button {
                runGitAction(.push)
            } label: {
                Label("Push", systemImage: "arrow.up")
            }
            Button {
                runGitAction(.fetch)
            } label: {
                Label("Fetch", systemImage: "arrow.clockwise")
            }
            if remoteURL != nil {
                Button {
                    GitService.shared.openRemote(at: projectPath)
                } label: {
                    Label("Open GitHub Remote", systemImage: "arrow.up.right.square")
                }
            }
            Divider()
            Text("\(changeCount) changed file\(changeCount == 1 ? "" : "s")")
                .font(.caption)
        }
    }

    private var badgeColor: Color {
        isSelected ? .white.opacity(0.9) : .orange.opacity(0.85)
    }

    private var badgeBgColor: Color {
        isSelected ? .white.opacity(0.15) : .orange.opacity(0.1)
    }

    private func refreshRemoteURL() {
        Task.detached { [projectPath] in
            let url = GitService.shared.remoteURL(at: projectPath)
            await MainActor.run {
                remoteURL = url
            }
        }
    }

    private func runGitAction(_ command: GitCommand) {
        Task.detached { [projectPath] in
            switch command {
            case .pull:
                GitService.shared.pull(at: projectPath)
            case .push:
                GitService.shared.push(at: projectPath)
            case .fetch:
                GitService.shared.fetch(at: projectPath)
            }
            await MainActor.run {
                onRefresh()
            }
        }
    }
}
