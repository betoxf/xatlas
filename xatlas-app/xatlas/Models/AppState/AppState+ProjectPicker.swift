import AppKit

extension AppState {
    /// Presents the macOS open-panel for picking a project folder.
    /// Whether the new project gets switched into the workspace or stays
    /// on the dashboard depends on where the user invoked the picker.
    @MainActor
    func presentProjectPicker() {
        guard !isProjectPickerPresented else { return }
        isProjectPickerPresented = true
        let additionBehavior: ProjectAdditionBehavior =
            selectedSection == .projects && projectSurfaceMode == .dashboard
            ? .stayOnDashboard
            : .selectInWorkspace

        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select a project folder"
        panel.prompt = "Open"

        let complete: (NSApplication.ModalResponse) -> Void = { [weak self, weak panel] response in
            guard let self else { return }
            defer { self.isProjectPickerPresented = false }
            guard response == .OK, let url = panel?.url else { return }
            self.addProject(
                name: url.lastPathComponent,
                path: url.path,
                behavior: additionBehavior
            )
        }

        if let window = NSApp.keyWindow ?? NSApp.mainWindow {
            panel.beginSheetModal(for: window, completionHandler: complete)
            return
        }

        NSApp.activate(ignoringOtherApps: true)
        let response = panel.runModal()
        complete(response)
    }
}
