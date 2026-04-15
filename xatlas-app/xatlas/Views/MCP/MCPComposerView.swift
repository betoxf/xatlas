import SwiftUI

struct MCPComposerView: View {
    let projectPath: String?
    let refresh: () -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var request = ""
    @State private var name = ""
    @State private var url = ""
    @State private var command = ""
    @State private var argsText = ""
    @State private var envText = ""
    @State private var selectedTargets: Set<MCPInstallTarget> = []
    @State private var isGenerating = false
    @State private var isSaving = false
    @State private var message = ""

    private var availableTargets: [MCPInstallTarget] {
        AgentCatalogService.shared.availableInstallTargets(projectPath: projectPath)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Add MCP")
                        .font(.system(size: 18, weight: .semibold))
                    Text("Generate a server config from a prompt or edit the fields directly, then install it to one or more clients.")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button("Done") {
                    dismiss()
                }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.55)))
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 10)

            Form {
                Section("Request") {
                    TextField("Example: Add the xatlas MCP at http://127.0.0.1:9012/mcp", text: $request, axis: .vertical)
                        .lineLimit(3...5)

                    Button(isGenerating ? "Generating…" : "Generate with AI") {
                        generate()
                    }
                    .disabled(isGenerating || request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                Section("Configuration") {
                    TextField("Server name", text: $name)
                    TextField("URL", text: $url)
                    TextField("Command", text: $command)
                    TextField("Args (comma separated)", text: $argsText)
                    TextField("Env (KEY=VALUE, comma separated)", text: $envText, axis: .vertical)
                        .lineLimit(2...4)
                }

                Section("Install To") {
                    ForEach(availableTargets) { target in
                        Toggle(isOn: binding(for: target)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(target.label)
                                Text(target.detail)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if !message.isEmpty {
                    Section {
                        Text(message)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .formStyle(.grouped)

            HStack {
                Spacer()
                Button(isSaving ? "Installing…" : "Install MCP") {
                    install()
                }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Capsule().fill(.white.opacity(0.65)))
                .disabled(isSaving || !canInstall)
            }
            .padding(20)
        }
        .frame(width: 560, height: 620)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            if selectedTargets.isEmpty {
                selectedTargets = Set(availableTargets)
            }
        }
    }

    private var canInstall: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !selectedTargets.isEmpty
            && (url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                || command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
    }

    private func binding(for target: MCPInstallTarget) -> Binding<Bool> {
        Binding(
            get: { selectedTargets.contains(target) },
            set: { isEnabled in
                if isEnabled {
                    selectedTargets.insert(target)
                } else {
                    selectedTargets.remove(target)
                }
            }
        )
    }

    private func generate() {
        isGenerating = true
        message = ""
        let sourceRequest = request
        let sourceProjectPath = projectPath

        Task.detached {
            let draft = MCPAuthoringService.shared.generateDraft(from: sourceRequest, projectPath: sourceProjectPath)
            await MainActor.run {
                isGenerating = false
                guard let draft else {
                    message = "Could not generate an MCP config from that request."
                    return
                }
                name = draft.name
                url = draft.url
                command = draft.command
                argsText = draft.args.joined(separator: ", ")
                envText = draft.env
                    .sorted { $0.key < $1.key }
                    .map { "\($0.key)=\($0.value)" }
                    .joined(separator: ", ")
                message = "Generated configuration. Review it, then install."
            }
        }
    }

    private func install() {
        isSaving = true
        message = ""

        let configuration = MCPConfiguration(
            url: trimmed(url),
            command: trimmed(command),
            args: parseCommaList(argsText),
            env: parseEnv(envText)
        )
        let selected = Array(selectedTargets)
        let normalizedName = name
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")

        Task.detached {
            let results = AgentCatalogService.shared.addMCP(
                named: normalizedName,
                configuration: configuration,
                targets: selected,
                projectPath: projectPath
            )
            let successTargets = selected.filter { results[$0] == true }
            await MainActor.run {
                isSaving = false
                if successTargets.isEmpty {
                    message = "Install failed."
                    return
                }
                message = "Installed to \(successTargets.map { $0.label }.joined(separator: ", "))."
                refresh()
            }
        }
    }

    private func parseCommaList(_ raw: String) -> [String] {
        raw
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func parseEnv(_ raw: String) -> [String: String] {
        Dictionary(uniqueKeysWithValues: raw
            .split(separator: ",")
            .compactMap { part -> (String, String)? in
                let pieces = part.split(separator: "=", maxSplits: 1).map(String.init)
                guard pieces.count == 2 else { return nil }
                let key = pieces[0].trimmingCharacters(in: .whitespacesAndNewlines)
                let value = pieces[1].trimmingCharacters(in: .whitespacesAndNewlines)
                guard !key.isEmpty else { return nil }
                return (key, value)
            })
    }

    private func trimmed(_ value: String) -> String? {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }
}
