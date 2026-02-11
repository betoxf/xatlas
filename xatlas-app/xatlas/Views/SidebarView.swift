import SwiftUI

struct SidebarView: View {
    @Bindable var state: AppState
    @State private var showAddProject = false
    @State private var newProjectPath = ""

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
                    showAddProject = true
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
        .sheet(isPresented: $showAddProject) {
            AddProjectSheet(state: state, isPresented: $showAddProject)
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

private struct AddProjectSheet: View {
    @Bindable var state: AppState
    @Binding var isPresented: Bool
    @State private var path = ""

    var body: some View {
        VStack(spacing: 16) {
            Text("Add Project").font(XatlasFont.title)
            TextField("Project path", text: $path)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Browse...") { browseForFolder() }
                Spacer()
                Button("Cancel") { isPresented = false }
                Button("Add") {
                    let name = URL(fileURLWithPath: path).lastPathComponent
                    state.addProject(name: name, path: path)
                    isPresented = false
                }
                .disabled(path.isEmpty)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 400)
    }

    private func browseForFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            path = url.path
        }
    }
}
