import SwiftUI

struct SidebarView: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top actions
            VStack(spacing: 2) {
                SidebarRow(icon: "plus.message", label: "New thread")
                SidebarRow(icon: "clock.arrow.circlepath", label: "Automations")
                SidebarRow(icon: "sparkles", label: "Skills")
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)
            .padding(.bottom, 12)

            // Section header
            HStack {
                Text("Projects")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 6)

            // Project list
            ScrollView {
                VStack(spacing: 1) {
                    ForEach(state.projects) { project in
                        ProjectRow(
                            project: project,
                            isSelected: state.selectedProject?.id == project.id
                        )
                        .onTapGesture { state.selectedProject = project }
                        .contextMenu {
                            Button("Remove") { state.removeProject(project) }
                        }
                    }
                }
                .padding(.horizontal, 8)
            }

            Spacer()

            // Bottom actions
            VStack(spacing: 2) {
                Divider().padding(.horizontal, 12).padding(.bottom, 4)
                SidebarRow(icon: "gearshape", label: "Settings")
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)

            // Add project
            Button { openFolderPicker() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .medium))
                    Text("Add Project")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
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

// MARK: - Sidebar row (top actions)

private struct SidebarRow: View {
    let icon: String
    let label: String
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(.primary.opacity(0.65))
                .frame(width: 18)

            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(.primary.opacity(0.8))

            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(isHovered ? 0.06 : 0), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .onHover { isHovered = $0 }
        .contentShape(Rectangle())
    }
}

// MARK: - Project row

private struct ProjectRow: View {
    let project: Project
    let isSelected: Bool
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder.fill")
                .font(.system(size: 12))
                .foregroundStyle(isSelected ? .blue : .primary.opacity(0.4))
                .frame(width: 18)

            Text(project.name)
                .font(.system(size: 13))
                .foregroundStyle(.primary.opacity(0.85))
                .lineLimit(1)

            Spacer()

            Text(timeAgo(project.createdAt))
                .font(.system(size: 11))
                .foregroundStyle(.secondary.opacity(0.6))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            Color.primary.opacity(isSelected ? 0.1 : (isHovered ? 0.06 : 0)),
            in: RoundedRectangle(cornerRadius: 6, style: .continuous)
        )
        .onHover { isHovered = $0 }
        .contentShape(Rectangle())
    }

    private func timeAgo(_ date: Date) -> String {
        let seconds = -date.timeIntervalSinceNow
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86400))d"
    }
}
