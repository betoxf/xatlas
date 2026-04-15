import SwiftUI

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

            SectionHeader(title: "Projects") {
                HeaderModeToggleButton(mode: state.projectSurfaceMode) {
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
                        ProjectItemView(
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
                SidebarCircleButton(icon: "gearshape.fill") { openSettings() }
                    .accessibilityLabel("Open settings")
                Spacer()
                SidebarCircleButton(icon: "plus") { state.presentProjectPicker() }
                    .accessibilityLabel("Add project")
            }
            .padding(.horizontal, XatlasLayout.sidebarInset)
            .padding(.bottom, XatlasLayout.sidebarInset)
        }
    }

    private func openSettings() {
        state.isSettingsPresented = true
    }
}

// MARK: - Project item (expandable with inline file tree)

private struct ProjectItemView: View {
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
            // Project row
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

                // Git status button
                if let status = gitStatus, status.isRepo, !status.changes.isEmpty {
                    GitInlineButton(
                        status: status,
                        isSelected: isSelected,
                        isSyncing: isSyncing,
                        onSync: { syncProject() },
                        onRefresh: { refreshGit() },
                        projectPath: project.path
                    )
                }

                // Chevron
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
            .background(selectionBackground)
            .contentShape(Rectangle())
            .onTapGesture {
                onSelect()
                withAnimation(XatlasMotion.layout) { isExpanded = true }
            }
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

            // Inline file tree
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

    @ViewBuilder
    private var selectionBackground: some View {
        if isSelected {
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor,
                            Color.accentColor.opacity(0.84)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    .white.opacity(0.32),
                                    .white.opacity(0.04)
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.6
                        )
                )
                .shadow(color: Color.accentColor.opacity(0.22), radius: 6, y: 2)
                .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
        } else {
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(XatlasSurface.hoverFill.opacity(isHovered ? 1 : 0))
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

// MARK: - Git inline button

private struct GitInlineButton: View {
    private enum GitCommand: Sendable {
        case pull
        case push
        case fetch
    }

    let status: GitStatus
    let isSelected: Bool
    let isSyncing: Bool
    let onSync: () -> Void
    let onRefresh: () -> Void
    let projectPath: String
    @State private var isGitHovered = false
    @State private var remoteURL: String?

    private var changeCount: Int { status.changes.count }
    private var hasChanges: Bool { changeCount > 0 }

    var body: some View {
        Button(action: onSync) {
            HStack(spacing: 3) {
                if isSyncing {
                    ProgressView()
                        .controlSize(.mini)
                        .scaleEffect(0.6)
                } else {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 10, weight: .medium))
                }

                Text("\(changeCount)")
                    .font(XatlasFont.badge)
            }
            .foregroundStyle(badgeColor)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(
                Capsule()
                    .fill(badgeBgColor)
                    .overlay(
                        Capsule()
                            .strokeBorder(badgeColor.opacity(0.18), lineWidth: 0.5)
                    )
            )
            .scaleEffect(isGitHovered ? 1.1 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { isGitHovered = $0 }
        .animation(XatlasMotion.hover, value: isGitHovered)
        .xatlasPressEffect(scale: 0.92)
        .onAppear { refreshRemoteURL() }
        .help("Commit & push \(changeCount) change\(changeCount == 1 ? "" : "s")")
        .contextMenu {
            Label(status.branch, systemImage: "arrow.triangle.branch")
                .font(.headline)
            Divider()
            Button {
                onSync()
            } label: {
                Label("AI Sync", systemImage: "sparkles")
            }
            Button {
                runGitAction(.pull)
            } label: {
                Label("Pull", systemImage: "arrow.down")
            }
            Button {
                runGitAction(.push)
            } label: {
                Label("Push", systemImage: "arrow.up")
            }
            Button {
                runGitAction(.fetch)
            } label: {
                Label("Fetch", systemImage: "arrow.clockwise")
            }
            if remoteURL != nil {
                Button {
                    GitService.shared.openRemote(at: projectPath)
                } label: {
                    Label("Open GitHub Remote", systemImage: "arrow.up.right.square")
                }
            }
            Divider()
            Text("\(changeCount) changed file\(changeCount == 1 ? "" : "s")")
                .font(.caption)
        }
    }

    private var badgeColor: Color {
        if isSelected {
            return .white.opacity(0.9)
        }
        return .orange.opacity(0.85)
    }

    private var badgeBgColor: Color {
        if isSelected {
            return .white.opacity(0.15)
        }
        return .orange.opacity(0.1)
    }

    private func refreshRemoteURL() {
        Task.detached { [projectPath] in
            let url = GitService.shared.remoteURL(at: projectPath)
            await MainActor.run {
                remoteURL = url
            }
        }
    }

    private func runGitAction(_ command: GitCommand) {
        Task.detached { [projectPath] in
            switch command {
            case .pull:
                GitService.shared.pull(at: projectPath)
            case .push:
                GitService.shared.push(at: projectPath)
            case .fetch:
                GitService.shared.fetch(at: projectPath)
            }
            await MainActor.run {
                onRefresh()
            }
        }
    }
}

// MARK: - Section header

private struct SectionHeader<Accessory: View>: View {
    let title: String
    @ViewBuilder let accessory: () -> Accessory

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(XatlasFont.sectionLabel)
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
                .tracking(0.5)
            Spacer()
            accessory()
        }
        .padding(.horizontal, XatlasLayout.sidebarInset + 4)
        .padding(.bottom, 8)
    }
}

private struct HeaderModeToggleButton: View {
    let mode: ProjectSurfaceMode
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: mode == .workspace ? "sidebar.left" : "square.grid.2x2")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color.primary.opacity(0.92))
                .frame(width: XatlasLayout.compactControlSize, height: XatlasLayout.compactControlSize)
                .background(
                    RoundedRectangle(cornerRadius: XatlasLayout.compactCornerRadius, style: .continuous)
                        .fill(.white.opacity(0.5))
                        .overlay(
                            RoundedRectangle(cornerRadius: XatlasLayout.compactCornerRadius, style: .continuous)
                                .strokeBorder(.white.opacity(0.40), lineWidth: 0.6)
                        )
                )
        }
        .buttonStyle(.plain)
        .xatlasPressEffect()
    }
}

// MARK: - File tree

struct FileTreeView: View {
    let rootPath: String
    let depth: Int
    let onFileSelect: (String) -> Void

    @State private var entries: [FileEntry] = []
    @State private var loaded = false

    init(rootPath: String, depth: Int, onFileSelect: @escaping (String) -> Void) {
        self.rootPath = rootPath
        self.depth = depth
        self.onFileSelect = onFileSelect

        let cached = FileTreeCache.shared.cachedEntries(at: rootPath)
        _entries = State(initialValue: cached ?? [])
        _loaded = State(initialValue: cached != nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(entries) { entry in
                if entry.isDirectory {
                    FolderRow(entry: entry, depth: depth, onFileSelect: onFileSelect)
                } else {
                    FileRow(entry: entry, depth: depth, onSelect: { onFileSelect(entry.path) })
                }
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            loadEntries()
        }
    }

    private func loadEntries() {
        FileTreeCache.shared.loadEntries(at: rootPath) { loadedEntries in
            entries = loadedEntries
        }
    }
}

// MARK: - Folder row

private struct FolderRow: View {
    let entry: FileEntry
    let depth: Int
    let onFileSelect: (String) -> Void
    @State private var isExpanded = false
    @State private var isHovered = false

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(XatlasMotion.layout) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 0) {
                    Spacer().frame(width: CGFloat(depth) * 14)

                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 14)

                    Image(systemName: isExpanded ? "folder.fill" : "folder")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(.blue.opacity(0.55))
                        .frame(width: 18)

                    Text(entry.name)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.primary.opacity(0.8))
                        .lineLimit(1)

                    Spacer()
                }
                .padding(.vertical, 3)
                .padding(.horizontal, 6)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.primary.opacity(isHovered ? 0.04 : 0))
                )
            }
            .buttonStyle(.plain)
            .onHover { isHovered = $0 }

            if isExpanded {
                FileTreeView(rootPath: entry.path, depth: depth + 1, onFileSelect: onFileSelect)
            }
        }
    }
}

// MARK: - File row

private struct FileRow: View {
    let entry: FileEntry
    let depth: Int
    let onSelect: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 0) {
                Spacer().frame(width: CGFloat(depth) * 14 + 14)

                Image(systemName: iconForFile(entry.name))
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(colorForFile(entry.name))
                    .frame(width: 18)

                Text(entry.name)
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(.primary.opacity(0.75))
                    .lineLimit(1)

                Spacer()
            }
            .padding(.vertical, 3)
            .padding(.horizontal, 6)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.primary.opacity(isHovered ? 0.04 : 0))
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }

    private func iconForFile(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "swift":                                      return "swift"
        case "js", "jsx", "mjs":                           return "doc.text"
        case "ts", "tsx":                                  return "doc.text.fill"
        case "py":                                         return "doc.text"
        case "json":                                       return "curlybraces"
        case "md", "txt", "rtf":                           return "doc.plaintext"
        case "html", "htm":                                return "globe"
        case "css", "scss", "less":                        return "paintbrush"
        case "yaml", "yml", "toml":                        return "list.bullet"
        case "png", "jpg", "jpeg", "gif", "svg", "webp":  return "photo"
        case "mp3", "wav", "aiff":                         return "waveform"
        case "mp4", "mov", "avi":                          return "film"
        case "pdf":                                        return "doc.richtext"
        case "zip", "tar", "gz", "rar":                    return "doc.zipper"
        case "sh", "bash", "zsh":                          return "terminal"
        case "lock":                                       return "lock"
        default:                                           return "doc"
        }
    }

    private func colorForFile(_ name: String) -> Color {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "swift":                                      return .orange.opacity(0.65)
        case "js", "jsx", "mjs":                           return .yellow.opacity(0.75)
        case "ts", "tsx":                                  return .blue.opacity(0.55)
        case "py":                                         return .green.opacity(0.65)
        case "json":                                       return .purple.opacity(0.5)
        case "md", "txt":                                  return .gray.opacity(0.5)
        case "html", "htm":                                return .orange.opacity(0.5)
        case "css", "scss":                                return .pink.opacity(0.55)
        case "png", "jpg", "jpeg", "gif", "svg":           return .teal.opacity(0.55)
        case "sh", "bash", "zsh":                          return .green.opacity(0.5)
        default:                                           return .gray.opacity(0.4)
        }
    }
}

// MARK: - File entry model

struct FileEntry: Identifiable {
    let name: String
    let path: String
    let isDirectory: Bool
    var id: String { path }
}

// MARK: - Sidebar item

private struct SidebarItem: View {
    let icon: String
    let label: String
    let isSelected: Bool
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isSelected ? .white : .primary.opacity(0.5))
                    .frame(width: 20, alignment: .center)

                Text(label)
                    .font(XatlasFont.body)
                    .foregroundStyle(isSelected ? .white : .primary)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .background(selectionBackground)
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .animation(XatlasMotion.fadeFast, value: isHovered)
        .animation(XatlasMotion.layout, value: isSelected)
        .xatlasPressEffect()
    }

    @ViewBuilder
    private var selectionBackground: some View {
        if isSelected {
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor,
                            Color.accentColor.opacity(0.84)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    .white.opacity(0.32),
                                    .white.opacity(0.04)
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.6
                        )
                )
                .shadow(color: Color.accentColor.opacity(0.22), radius: 6, y: 2)
                .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
        } else {
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(XatlasSurface.hoverFill.opacity(isHovered ? 1 : 0))
        }
    }
}

// MARK: - Circular glass button

private struct SidebarCircleButton: View {
    let icon: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.primary.opacity(0.5))
                .frame(width: XatlasLayout.controlSize, height: XatlasLayout.controlSize)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(isHovered ? XatlasSurface.controlFillHovered : XatlasSurface.controlFill)
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .stroke(.white.opacity(0.34), lineWidth: 1)
                )
        )
        .onHover { isHovered = $0 }
        .scaleEffect(isHovered ? 1.08 : 1.0)
        .animation(XatlasMotion.hover, value: isHovered)
        .xatlasPressEffect()
    }
}
