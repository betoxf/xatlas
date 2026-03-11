import AppKit
import SwiftUI

struct ProjectDashboardView: View {
    @Bindable var state: AppState

    private let columns = [
        GridItem(.adaptive(minimum: 240, maximum: 320), spacing: 18, alignment: .top)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Projects")
                            .font(.system(size: 22, weight: .semibold))
                        Text("Switch between repos, launch terminals, and route AI actions from one surface.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                    }

                    Spacer()

                    Button {
                        openFolderPicker()
                    } label: {
                        Label("Add Project", systemImage: "plus")
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(Capsule().fill(.white.opacity(0.48)))
                    }
                    .buttonStyle(.plain)
                }

                LazyVGrid(columns: columns, spacing: 18) {
                    ForEach(state.projects) { project in
                        ProjectDashboardCard(project: project, state: state)
                    }

                    AddProjectTile(action: openFolderPicker)
                }
            }
            .padding(18)
        }
    }

    private func openFolderPicker() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select a project folder"
        panel.prompt = "Open"
        panel.begin { response in
            if response == .OK, let url = panel.url {
                state.addProject(name: url.lastPathComponent, path: url.path)
            }
        }
    }
}

private struct ProjectDashboardCard: View {
    let project: Project
    @Bindable var state: AppState

    @State private var gitStatus = GitStatus(branch: "", changes: [], isRepo: false)
    @State private var isHovered = false
    @State private var isSummarizing = false

    private var sessions: [TerminalSession] {
        TerminalService.shared.sessionsForProject(project.id)
    }

    private var attentionCount: Int {
        state.projectAttentionCount(project.id)
    }

    private var isSelected: Bool {
        state.selectedProject?.id == project.id && state.projectSurfaceMode == .workspace
    }

    var body: some View {
        let _ = state.terminalEventVersion

        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(project.name)
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        if attentionCount > 0 {
                            Text("\(attentionCount)")
                                .font(.system(size: 10, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(.red.opacity(0.8)))
                        }
                    }

                    Text(project.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary.opacity(0.55))
            }

            HStack(spacing: 8) {
                dashboardBadge(text: gitStatus.isRepo ? gitStatus.branch : "folder", tint: .blue)
                dashboardBadge(text: "\(sessions.count) terminal\(sessions.count == 1 ? "" : "s")", tint: .green)
                if gitStatus.isRepo {
                    dashboardBadge(text: "\(gitStatus.changes.count) change\(gitStatus.changes.count == 1 ? "" : "s")", tint: gitStatus.changes.isEmpty ? .gray : .orange)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(primarySessionTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary.opacity(0.78))
                    .lineLimit(1)

                Text(primarySessionSubtitle)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.34))
            )

            HStack(spacing: 8) {
                actionButton(label: "Open", icon: "rectangle.stack") {
                    state.switchToProject(project)
                }

                actionButton(label: isSummarizing ? "Running" : "Brief", icon: "sparkles", disabled: isSummarizing) {
                    isSummarizing = true
                    let sessionID = state.runProjectBrief(for: project)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                        isSummarizing = false
                        if sessionID == nil {
                            NSSound.beep()
                        }
                    }
                }

                actionButton(label: "Finder", icon: "folder") {
                    NSWorkspace.shared.open(URL(fileURLWithPath: project.path))
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, minHeight: 238, alignment: .topLeading)
        .background(cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(strokeColor, lineWidth: isSelected ? 1.4 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture {
            state.switchToProject(project)
        }
        .onHover { isHovered = $0 }
        .onAppear(perform: refresh)
    }

    private var primarySessionTitle: String {
        sessions.first?.displayTitle ?? "No terminal yet"
    }

    private var primarySessionSubtitle: String {
        if let session = sessions.first {
            if session.requiresAttention {
                return "Finished work and waiting for review."
            }
            return session.activityState.label
        }
        return "Open the project to start a terminal or run a brief AI summary."
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(.white.opacity(isHovered || isSelected ? 0.62 : 0.48))
            .shadow(color: .black.opacity(isSelected ? 0.12 : 0.08), radius: 16, y: 8)
    }

    private var strokeColor: Color {
        if isSelected {
            return .accentColor.opacity(0.58)
        }
        return .white.opacity(0.32)
    }

    private func refresh() {
        Task.detached { [path = project.path] in
            let status = GitService.shared.status(at: path)
            await MainActor.run {
                gitStatus = status
            }
        }
    }

    private func dashboardBadge(text: String, tint: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .foregroundStyle(tint.opacity(0.8))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(tint.opacity(0.08)))
    }

    private func actionButton(label: String, icon: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(disabled ? Color.secondary : Color.primary.opacity(0.8))
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                Capsule().fill(.white.opacity(disabled ? 0.18 : 0.42))
            )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

private struct AddProjectTile: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 12) {
                Image(systemName: "plus")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(.secondary.opacity(0.8))
                Text("Add Project")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 238)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [7, 7]))
                    .foregroundStyle(.secondary.opacity(isHovered ? 0.45 : 0.25))
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}
