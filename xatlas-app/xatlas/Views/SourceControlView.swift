import SwiftUI

struct SourceControlView: View {
    let projectPath: String
    @State private var gitStatus: GitStatus?
    @State private var isExpanded = true
    @State private var commitMessage = ""
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            Button {
                withAnimation(XatlasMotion.layout) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("SOURCE CONTROL")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .tracking(0.5)

                    if let status = gitStatus, status.isRepo {
                        Text(status.branch)
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                            .foregroundStyle(.blue.opacity(0.6))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(
                                Capsule().fill(.blue.opacity(0.08))
                            )

                        if !status.changes.isEmpty {
                            Text("\(status.changes.count)")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(.orange.opacity(0.8))
                        }
                    }

                    Spacer()

                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.bottom, 6)

            if isExpanded, let status = gitStatus {
                if !status.isRepo {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                        Text("Not a git repository")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                } else if status.changes.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 11))
                            .foregroundStyle(.green.opacity(0.6))
                        Text("Working tree clean")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                } else {
                    // Commit input
                    HStack(spacing: 6) {
                        TextField("Message", text: $commitMessage)
                            .textFieldStyle(.plain)
                            .font(.system(size: 11.5))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(Color.primary.opacity(0.04))
                            )

                        Button {
                            commitAll()
                        } label: {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 24, height: 24)
                                .background(
                                    Circle().fill(commitMessage.isEmpty ? Color.gray.opacity(0.3) : Color.accentColor)
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(commitMessage.isEmpty)
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)

                    // Action buttons
                    HStack(spacing: 6) {
                        GitActionButton(icon: "arrow.down.circle", label: "Pull") {
                            Task.detached { GitService.shared.pull(at: projectPath) }
                            refresh()
                        }
                        GitActionButton(icon: "arrow.up.circle", label: "Push") {
                            Task.detached { GitService.shared.push(at: projectPath) }
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)

                    // Changed files
                    VStack(spacing: 1) {
                        ForEach(status.changes) { change in
                            GitChangeRow(change: change)
                        }
                    }
                }
            }
        }
        .onAppear { refresh() }
        .onChange(of: projectPath) { _, _ in refresh() }
    }

    private func refresh() {
        Task.detached { [projectPath] in
            let status = GitService.shared.status(at: projectPath)
            await MainActor.run { self.gitStatus = status }
        }
    }

    private func commitAll() {
        let msg = commitMessage
        commitMessage = ""
        Task.detached { [projectPath] in
            GitService.shared.stageAll(at: projectPath)
            GitService.shared.commit(at: projectPath, message: msg)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { refresh() }
    }
}

// MARK: - Git change row

private struct GitChangeRow: View {
    let change: GitChange
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 6) {
            Text(change.status.label)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(statusColor)
                .frame(width: 14)

            Image(systemName: fileIcon)
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .frame(width: 14)

            Text(shortName)
                .font(.system(size: 12))
                .foregroundStyle(.primary.opacity(0.75))
                .lineLimit(1)

            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color.primary.opacity(isHovered ? 0.04 : 0))
        )
        .onHover { isHovered = $0 }
    }

    private var statusColor: Color {
        switch change.status {
        case .modified: return .orange.opacity(0.8)
        case .added: return .green.opacity(0.7)
        case .deleted: return .red.opacity(0.7)
        case .untracked: return .gray.opacity(0.6)
        case .renamed: return .blue.opacity(0.7)
        }
    }

    private var fileIcon: String {
        change.status == .deleted ? "minus.circle" : "doc.text"
    }

    private var shortName: String {
        URL(fileURLWithPath: change.file).lastPathComponent
    }
}

// MARK: - Git action button

private struct GitActionButton: View {
    let icon: String
    let label: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .medium))
                Text(label)
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(.primary.opacity(0.6))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.primary.opacity(isHovered ? 0.06 : 0.03))
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}
