import SwiftUI

struct SidebarView: View {
    @Bindable var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Spacer for traffic lights alignment
            Spacer().frame(height: 38)

            // Top actions
            VStack(spacing: 1) {
                SidebarItem(icon: "server.rack", label: "MCP", isSelected: false) {}
                SidebarItem(icon: "arrow.triangle.2.circlepath", label: "Automations", isSelected: false) {}
                SidebarItem(icon: "square.stack.3d.up.fill", label: "Skills", isSelected: false) {}
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 14)

            // Section header
            SectionHeader(title: "Projects")

            // Project list with inline file tree
            ScrollView {
                VStack(spacing: 1) {
                    ForEach(state.projects) { project in
                        ProjectItemView(
                            project: project,
                            isSelected: state.selectedProject?.id == project.id,
                            onSelect: { state.selectedProject = project },
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
                SidebarCircleButton(icon: "gearshape.fill") {}
                Spacer()
                SidebarCircleButton(icon: "plus") { openFolderPicker() }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
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

// MARK: - Project item (expandable with inline file tree)

private struct ProjectItemView: View {
    let project: Project
    let isSelected: Bool
    let onSelect: () -> Void
    let onFileSelect: (String) -> Void
    let onRemove: () -> Void
    @State private var isExpanded = false
    @State private var isHovered = false

    var body: some View {
        VStack(spacing: 0) {
            // Project row
            Button {
                onSelect()
                withAnimation(.easeOut(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 12)

                    Image(systemName: "folder.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(isSelected ? .white : .blue.opacity(0.6))
                        .frame(width: 20, alignment: .center)

                    Text(project.name)
                        .font(.system(size: 13, weight: isSelected ? .medium : .regular))
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
            .contextMenu {
                Button("Remove") { onRemove() }
            }

            // Inline file tree
            if isExpanded {
                FileTreeView(rootPath: project.path, depth: 1, onFileSelect: onFileSelect)
                    .padding(.leading, 4)
            }
        }
    }
}

// MARK: - Section header

private struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.tertiary)
            .textCase(.uppercase)
            .tracking(0.5)
            .padding(.horizontal, 18)
            .padding(.bottom, 6)
    }
}

// MARK: - File tree

struct FileTreeView: View {
    let rootPath: String
    let depth: Int
    let onFileSelect: (String) -> Void

    @State private var entries: [FileEntry] = []
    @State private var loaded = false

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
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(atPath: rootPath) else { return }

        entries = items
            .filter { !$0.hasPrefix(".") && $0 != "node_modules" && $0 != ".build" }
            .sorted { a, b in
                let aIsDir = isDirectory(rootPath + "/" + a)
                let bIsDir = isDirectory(rootPath + "/" + b)
                if aIsDir != bIsDir { return aIsDir }
                return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
            }
            .prefix(50)
            .map { name in
                let path = rootPath + "/" + name
                return FileEntry(name: name, path: path, isDirectory: isDirectory(path))
            }
    }

    private func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: path, isDirectory: &isDir)
        return isDir.boolValue
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
        .glassEffect(.regular, in: Circle())
        .onHover { isHovered = $0 }
        .scaleEffect(isHovered ? 1.08 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
    }
}
