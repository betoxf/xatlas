import SwiftUI

/// Inline source-control panel currently bound to a single project path.
/// Renders a collapsible header, optional commit field + push/pull
/// buttons, and a list of changed files.
struct SourceControlView: View {
    let projectPath: String
    @State private var gitStatus: GitStatus?
    @State private var isExpanded = true
    @State private var commitMessage = ""
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
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
                    notARepoState
                } else if status.changes.isEmpty {
                    cleanState
                } else {
                    commitInput
                    actionButtons
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

    private var notARepoState: some View {
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
    }

    private var cleanState: some View {
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
    }

    private var commitInput: some View {
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
    }

    private var actionButtons: some View {
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
