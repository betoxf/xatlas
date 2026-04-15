import SwiftUI

/// Top-level sidebar layout. Composes section navigation, the projects
/// list (with inline file trees), and the bottom action row.
struct SidebarView: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer().frame(height: XatlasLayout.trafficLightClearance)

            VStack(spacing: 4) {
                SidebarItem(icon: "server.rack", label: "MCP", isSelected: state.selectedSection == .mcp) {
                    state.selectedSection = .mcp
                }
                SidebarItem(icon: "arrow.triangle.2.circlepath", label: "Automations", isSelected: state.selectedSection == .automations) {
                    state.selectedSection = .automations
                }
                SidebarItem(icon: "square.stack.3d.up.fill", label: "Skills", isSelected: state.selectedSection == .skills) {
                    state.selectedSection = .skills
                }
            }
            .padding(.horizontal, XatlasLayout.sidebarInset)
            .padding(.bottom, 18)

            SidebarSectionHeader(title: "Projects") {
                SidebarProjectsToggle(mode: state.projectSurfaceMode) {
                    if state.projectSurfaceMode == .workspace {
                        state.showProjectDashboard()
                    } else {
                        state.showProjectWorkspace()
                    }
                }
                .accessibilityLabel(state.projectSurfaceMode == .workspace ? "Project dashboard" : "Project workspace")
            }

            ScrollView {
                VStack(spacing: 6) {
                    ForEach(state.projects) { project in
                        SidebarProjectRow(
                            project: project,
                            attentionCount: state.projectAttentionCount(project.id),
                            isSelected: state.selectedSection == .projects && state.selectedProject?.id == project.id,
                            removeWarningText: state.projectCloseWarningText(for: project),
                            onSelect: {
                                state.selectedSection = .projects
                                if state.projectSurfaceMode == .dashboard {
                                    state.switchToProject(project, forceWorkspace: false)
                                    state.openProjectQuickView(id: project.id)
                                } else {
                                    state.switchToProject(project)
                                }
                            },
                            onFileSelect: { path in
                                let tab = TabItem(
                                    id: path,
                                    title: URL(fileURLWithPath: path).lastPathComponent,
                                    kind: .editor(filePath: path)
                                )
                                state.openTab(tab)
                            },
                            onRemove: { state.removeProject(project) }
                        )
                    }
                }
                .padding(.horizontal, XatlasLayout.sidebarInset)
                .padding(.bottom, 6)
            }

            Spacer(minLength: 8)

            HStack(spacing: 10) {
                SidebarCircleButton(icon: "gearshape.fill") { state.isSettingsPresented = true }
                    .accessibilityLabel("Open settings")
                Spacer()
                SidebarCircleButton(icon: "plus") { state.presentProjectPicker() }
                    .accessibilityLabel("Add project")
            }
            .padding(.horizontal, XatlasLayout.sidebarInset)
            .padding(.bottom, XatlasLayout.sidebarInset)
        }
    }
}
