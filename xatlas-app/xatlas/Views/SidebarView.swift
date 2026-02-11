import SwiftUI

struct SidebarView: View {
    @Bindable var state: AppState

    var body: some View {
        List(selection: $state.selectedProject) {
            Section("Projects") {
                ForEach(state.projects) { project in
                    ProjectRow(project: project, isSelected: state.selectedProject?.id == project.id)
                        .tag(project)
                        .contextMenu {
                            Button("Remove") { state.removeProject(project) }
                        }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button {
                    openFolderPicker()
                } label: {
                    Label("Add Project", systemImage: "plus")
                        .font(XatlasFont.sidebarCaption)
                }
                .buttonStyle(.plain)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
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
                let name = url.lastPathComponent
                state.addProject(name: name, path: url.path)
            }
        }
    }
}

private struct ProjectRow: View {
    let project: Project
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(project.name)
                .font(XatlasFont.sidebar)
            Text(project.path)
                .font(XatlasFont.sidebarCaption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}
