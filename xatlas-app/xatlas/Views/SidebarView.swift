import SwiftUI

struct SidebarView: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Spacer for traffic lights alignment
            Spacer().frame(height: 38)

            // Top actions
            VStack(spacing: 1) {
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
            .padding(.horizontal, 10)
            .padding(.bottom, 14)

            // Section header
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

            // Project list
            ScrollView {
                VStack(spacing: 1) {
                    ForEach(state.projects) { project in
                        ProjectItemView(
                            project: project,
                            attentionCount: state.projectAttentionCount(project.id),
                            isSelected: state.selectedSection == .projects && state.selectedProject?.id == project.id,
                            onSelect: {
                                state.selectedSection = .projects
                                if state.projectSurfaceMode == .dashboard {
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
                .padding(.horizontal, 10)
            }

            Spacer(minLength: 8)

            // Bottom glass buttons
            HStack(spacing: 10) {
                SidebarCircleButton(icon: "gearshape.fill") { openSettings() }
                    .accessibilityLabel("Open settings")
                Spacer()
                SidebarCircleButton(icon: "plus") { state.presentProjectPicker() }
                    .accessibilityLabel("Add project")
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
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
    let onSelect: () -> Void
    let onFileSelect: (String) -> Void
    let onRemove: () -> Void
    @State private var isExpanded = false
    @State private var isHovered = false
    @State private var gitStatus: GitStatus?
    @State private var isSyncing = false

    var body: some View {
        VStack(spacing: 0) {
            // Project row
            HStack(spacing: 8) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(isSelected ? .white : .blue.opacity(0.6))
                    .frame(width: 20, alignment: .center)

                Text(project.name)
                    .font(.system(size: 13, weight: isSelected ? .medium : .regular))
                    .foregroundStyle(isSelected ? .white : .primary)
                    .lineLimit(1)

                Spacer()

                if attentionCount > 0 {
                    Text("\(attentionCount)")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(
                            Capsule().fill(.red.opacity(isSelected ? 0.82 : 0.72))
                        )
                }

                // Git status button
                if let status = gitStatus, status.isRepo {
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
                    withAnimation(.easeOut(duration: 0.15)) { isExpanded.toggle() }
                } label: {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(isSelected ? Color.white.opacity(0.7) : Color.gray.opacity(0.5))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isSelected ? Color.accentColor : Color.primary.opacity(isHovered ? 0.05 : 0))
            )
            .contentShape(Rectangle())
            .onTapGesture(count: 2) {
                onSelect()
                withAnimation(.easeOut(duration: 0.15)) { isExpanded.toggle() }
            }
            .onTapGesture(count: 1) {
                onSelect()
            }
            .onHover { isHovered = $0 }
            .contextMenu {
                Button("Remove") { onRemove() }
            }

            // Inline file tree
            if isExpanded {
                FileTreeView(rootPath: project.path, depth: 1, onFileSelect: onFileSelect)
                    .padding(.leading, 4)
            }
        }
        .onAppear { refreshGit() }
        .onChange(of: isSelected) { _, sel in if sel { refreshGit() } }
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
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 10, weight: .medium))
                }

                if hasChanges {
                    Text("\(changeCount)")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                }
            }
            .foregroundStyle(badgeColor)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(
                Capsule()
                    .fill(badgeBgColor)
            )
            .scaleEffect(isGitHovered ? 1.1 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { isGitHovered = $0 }
        .animation(.easeOut(duration: 0.12), value: isGitHovered)
        .onAppear { refreshRemoteURL() }
        .help(hasChanges ? "Commit & push \(changeCount) change\(changeCount == 1 ? "" : "s")" : "Up to date — \(status.branch)")
        .contextMenu {
            Text(status.branch).font(.headline)
            Divider()
            Button("AI Sync") { onSync() }
            Button("Pull") {
                Task.detached {
                    GitService.shared.pull(at: projectPath)
                    await MainActor.run { onRefresh() }
                }
            }
            Button("Push") {
                Task.detached {
                    GitService.shared.push(at: projectPath)
                    await MainActor.run { onRefresh() }
                }
            }
            Button("Fetch") {
                Task.detached {
                    GitService.shared.fetch(at: projectPath)
                    await MainActor.run { onRefresh() }
                }
            }
            if remoteURL != nil {
                Button("Open GitHub Remote") {
                    GitService.shared.openRemote(at: projectPath)
                }
            }
            Divider()
            if hasChanges {
                Text("\(changeCount) changed file\(changeCount == 1 ? "" : "s")")
                    .font(.caption)
            }
        }
    }

    private var badgeColor: Color {
        if isSelected {
            return .white.opacity(0.9)
        }
        return hasChanges ? .orange.opacity(0.85) : .green.opacity(0.65)
    }

    private var badgeBgColor: Color {
        if isSelected {
            return .white.opacity(0.15)
        }
        return hasChanges ? .orange.opacity(0.1) : .green.opacity(0.06)
    }

    private func refreshRemoteURL() {
        Task.detached { [projectPath] in
            let url = GitService.shared.remoteURL(at: projectPath)
            await MainActor.run {
                remoteURL = url
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
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
                .tracking(0.5)
            Spacer()
            accessory()
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 6)
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
                .frame(width: 22, height: 22)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(.white.opacity(0.44))
                )
        }
        .buttonStyle(.plain)
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
                withAnimation(.easeOut(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 0) {
                    Spacer().frame(width: CGFloat(depth) * 14)

                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 14)

                    Image(systemName: isExpanded ? "folder.fill" : "folder")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.blue.opacity(0.55))
                        .frame(width: 18)

                    Text(entry.name)
                        .font(.system(size: 12))
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
                    .font(.system(size: 11.5))
                    .foregroundStyle(colorForFile(entry.name))
                    .frame(width: 18)

                Text(entry.name)
                    .font(.system(size: 12))
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
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(isSelected ? .white : .primary.opacity(0.5))
                    .frame(width: 20, alignment: .center)

                Text(label)
                    .font(.system(size: 13))
                    .foregroundStyle(isSelected ? .white : .primary)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isSelected ? Color.accentColor : Color.primary.opacity(isHovered ? 0.05 : 0))
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
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
                .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .background(
            Circle().fill(.white.opacity(isHovered ? 0.5 : 0.32))
        )
        .onHover { isHovered = $0 }
        .scaleEffect(isHovered ? 1.08 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
    }
}
