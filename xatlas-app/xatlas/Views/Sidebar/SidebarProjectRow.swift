import SwiftUI

/// Expandable project row in the sidebar. Shows the project name + git
/// status, expands inline to reveal the file tree, and routes selection /
/// file-open / close actions to AppState.
struct SidebarProjectRow: View {
    let project: Project
    let attentionCount: Int
    let isSelected: Bool
    let removeWarningText: String
    let onSelect: () -> Void
    let onFileSelect: (String) -> Void
    let onRemove: () -> Void
    @State private var isExpanded = false
    @State private var isHovered = false
    @State private var gitStatus: GitStatus?
    @State private var isSyncing = false
    @State private var isRemoveConfirmationPresented = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "folder.fill")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(isSelected ? .white : .blue.opacity(0.6))
                        .frame(width: 20, alignment: .center)

                    Text(project.name)
                        .font(isSelected ? XatlasFont.bodyMedium : XatlasFont.body)
                        .foregroundStyle(isSelected ? .white : .primary)
                        .lineLimit(1)

                    Spacer()

                    if attentionCount > 0 {
                        Text("\(attentionCount)")
                            .font(XatlasFont.badge)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .xatlasBadgeFill(tint: .red)
                    }

                    if let status = gitStatus, status.isRepo, !status.changes.isEmpty {
                        SidebarGitButton(
                            status: status,
                            isSelected: isSelected,
                            isSyncing: isSyncing,
                            onSync: { syncProject() },
                            onRefresh: { refreshGit() },
                            projectPath: project.path
                        )
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    onSelect()
                    withAnimation(XatlasMotion.layout) { isExpanded = true }
                }

                Button {
                    withAnimation(XatlasMotion.layout) { isExpanded.toggle() }
                } label: {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(isSelected ? Color.white.opacity(0.7) : Color.gray.opacity(0.5))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .xatlasPressEffect(scale: 0.88)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .background(SidebarSelectionBackground(isSelected: isSelected, isHovered: isHovered))
            .onHover { isHovered = $0 }
            .animation(XatlasMotion.fadeFast, value: isHovered)
            .animation(XatlasMotion.layout, value: isSelected)
            .contextMenu {
                Button("Close Project") { isRemoveConfirmationPresented = true }
            }
            .confirmationDialog(
                "Close project?",
                isPresented: $isRemoveConfirmationPresented
            ) {
                Button("Close Project and Kill Terminals", role: .destructive) {
                    onRemove()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(removeWarningText)
            }

            if isExpanded {
                FileTreeView(rootPath: project.path, depth: 1, onFileSelect: onFileSelect)
                    .padding(.leading, 4)
            }
        }
        .onAppear { refreshGit() }
        .onChange(of: isSelected) { _, sel in
            if sel {
                refreshGit()
                withAnimation(XatlasMotion.layout) { isExpanded = true }
            }
        }
    }

    private func refreshGit() {
        Task.detached { [path = project.path] in
            let s = GitService.shared.status(at: path)
            await MainActor.run { gitStatus = s }
        }
    }

    private func syncProject() {
        guard !isSyncing, let status = gitStatus else { return }
        isSyncing = true
        let path = project.path
        Task.detached {
            GitService.shared.stageAll(at: path)
            let refreshedStatus = GitService.shared.status(at: path)
            let message = AISyncService.shared.commitMessage(for: path, status: refreshedStatus.isRepo ? refreshedStatus : status)
            GitService.shared.commit(at: path, message: message)
            if AppPreferences.shared.pushAfterSync {
                GitService.shared.push(at: path)
            }
            await MainActor.run {
                isSyncing = false
                refreshGit()
            }
        }
    }
}
