import AppKit
import SwiftUI

/// The projects-section dashboard surface — a grid of project cards plus
/// a bottom operator overlay (collapsed dock or expanded chat tray).
struct ProjectDashboardView: View {
    @Bindable var state: AppState
    @State private var operatorService = ProjectOperatorService.shared
    @State private var operatorInput = ""
    @State private var isOperatorCollapsed = true
    @FocusState private var isOperatorFocused: Bool

    private let columns = [
        GridItem(.adaptive(minimum: 214, maximum: 258), spacing: 16, alignment: .top)
    ]

    private var filteredProjects: [Project] {
        let query = state.dashboardSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return state.projects }
        return state.projects.filter { $0.name.lowercased().contains(query) }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(filteredProjects) { project in
                        ProjectDashboardCard(
                            project: project,
                            state: state,
                            onQuickView: {
                                _ = state.openProjectQuickView(id: project.id)
                            }
                        )
                    }

                    AddProjectTile(action: state.presentProjectPicker)
                }
                .padding(18)
                .padding(.bottom, isOperatorCollapsed ? 84 : 198)
            }
            .simultaneousGesture(
                TapGesture().onEnded {
                    activateOperatorInput()
                }
            )

            DashboardOperatorOverlay(
                messages: Array(operatorService.consoleMessages.suffix(6)),
                isReady: operatorService.isGlobalOperatorReady,
                input: $operatorInput,
                isCollapsed: $isOperatorCollapsed,
                isFocused: $isOperatorFocused,
                addProject: state.presentProjectPicker,
                send: sendOperatorMessage,
                activateInput: activateOperatorInput
            )
            .padding(.horizontal, 22)
            .padding(.bottom, 14)
        }
    }

    private func sendOperatorMessage() {
        let trimmed = operatorInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = operatorService.sendConsoleMessage(trimmed, preferredProject: nil)
        operatorInput = ""
        activateOperatorInput()
    }

    private func activateOperatorInput() {
        guard !isOperatorCollapsed else { return }
        _ = operatorService.activateConsole()
        isOperatorFocused = true
    }
}
