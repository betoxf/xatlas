import Foundation

struct TerminalTools: MCPToolSet {
    var tools: [MCPTool] {
        [
            createTerminal,
            selectTerminal,
            closeTerminal,
            listTerminals,
            listTabs,
            selectTab,
            closeTab,
            sendToTerminal,
            snapshotTerminal,
            listProjects,
            addProject,
            selectProject,
            showProjectSurface,
            showProjectQuickView,
            closeProjectQuickView,
            projectBrief,
            generateMCP,
            addMCP,
            removeProject,
            workspaceState,
        ]
    }

    private var createTerminal: MCPTool {
        MCPTool(
            name: "xatlas_terminal_create",
            definition: MCPToolDefinition(
                name: "xatlas_terminal_create",
                description: "Create a new tmux-backed terminal session and optionally select it in the app",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "name": ["type": "string", "description": "Initial terminal title"],
                        "cwd": ["type": "string", "description": "Working directory"],
                        "projectId": ["type": "string", "description": "Optional project UUID to associate with the session"],
                        "select": ["type": "boolean", "description": "Open and select the terminal tab inside the app"]
                    ])
                ]
            ),
            execute: { args in
                let name = args["name"] as? String
                let projectID = Self.uuid(from: args["projectId"] as? String) ?? Self.onMain { AppState.shared.selectedProject?.id }
                let cwd = Self.trimmedOrNil(args["cwd"] as? String) ?? {
                    guard let projectID else { return nil }
                    return Self.onMain { AppState.shared.projects.first(where: { $0.id == projectID })?.path }
                }()
                let select = args["select"] as? Bool ?? true

                let session = TerminalService.shared.createSession(title: name, projectID: projectID, workingDirectory: cwd)
                if select {
                    _ = Self.onMain { AppState.shared.openTerminalSession(session.id) }
                }

                return "{\"sessionId\":\"\(Self.escape(session.id))\",\"title\":\"\(Self.escape(session.displayTitle))\",\"tmuxSession\":\"\(Self.escape(session.tmuxSessionName))\",\"selected\":\(select ? "true" : "false")}"
            }
        )
    }

    private var selectTerminal: MCPTool {
        MCPTool(
            name: "xatlas_terminal_select",
            definition: MCPToolDefinition(
                name: "xatlas_terminal_select",
                description: "Open and select an existing terminal session in the app UI state",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "sessionId": ["type": "string", "description": "Tracked terminal session ID"]
                    ]),
                    "required": AnyCodable(["sessionId"])
                ]
            ),
            execute: { args in
                guard let sessionID = args["sessionId"] as? String else {
                    return "{\"ok\":false,\"error\":\"sessionId is required\"}"
                }
                let ok = Self.onMain { AppState.shared.openTerminalSession(sessionID) }
                return "{\"ok\":\(ok ? "true" : "false")}"
            }
        )
    }

    private var closeTerminal: MCPTool {
        MCPTool(
            name: "xatlas_terminal_close",
            definition: MCPToolDefinition(
                name: "xatlas_terminal_close",
                description: "Close a tracked terminal session and optionally kill the backing tmux session",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "sessionId": ["type": "string", "description": "Tracked terminal session ID"],
                        "killTmux": ["type": "boolean", "description": "Also kill the backing tmux session"],
                        "force": ["type": "boolean", "description": "Force close even if the terminal looks active"]
                    ]),
                    "required": AnyCodable(["sessionId"])
                ]
            ),
            execute: { args in
                guard let sessionID = args["sessionId"] as? String else {
                    return "{\"ok\":false,\"error\":\"sessionId is required\"}"
                }
                let killTmux = args["killTmux"] as? Bool ?? true
                let force = args["force"] as? Bool ?? false
                let needsConfirmation = Self.onMain { AppState.shared.terminalNeedsCloseConfirmation(sessionID) }
                if needsConfirmation && !force {
                    return "{\"ok\":false,\"needsConfirmation\":true,\"error\":\"terminal is active; pass force=true to kill it\"}"
                }
                let ok = Self.onMain { AppState.shared.closeTerminalSession(sessionID, killTmux: killTmux) }
                return "{\"ok\":\(ok ? "true" : "false"),\"killedTmux\":\(killTmux ? "true" : "false")}"
            }
        )
    }

    private var listTerminals: MCPTool {
        MCPTool(
            name: "xatlas_terminal_list",
            definition: MCPToolDefinition(
                name: "xatlas_terminal_list",
                description: "List tracked tmux-backed terminal sessions",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([String: String]())
                ]
            ),
            execute: { _ in
                let selectedSessionID: String? = {
                    guard case .terminal(let sessionID) = Self.onMain({ AppState.shared.selectedTab?.kind }) else { return nil }
                    return sessionID
                }()

                let sessions = TerminalService.shared.sessions
                let list = sessions.map {
                    "{\"id\":\"\(Self.escape($0.id))\",\"title\":\"\(Self.escape($0.displayTitle))\",\"tmuxSession\":\"\(Self.escape($0.tmuxSessionName))\",\"projectId\":\"\(Self.escape($0.projectID?.uuidString ?? ""))\",\"cwd\":\"\(Self.escape($0.currentDirectory ?? $0.workingDirectory ?? ""))\",\"state\":\"\(Self.escape($0.activityState.rawValue))\",\"selected\":\($0.id == selectedSessionID ? "true" : "false")}"
                }
                return "[\(list.joined(separator: ","))]"
            }
        )
    }

    private var sendToTerminal: MCPTool {
        MCPTool(
            name: "xatlas_terminal_send",
            definition: MCPToolDefinition(
                name: "xatlas_terminal_send",
                description: "Send a command to an existing terminal session",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "sessionId": ["type": "string", "description": "Tracked terminal session ID"],
                        "command": ["type": "string", "description": "Command to execute"]
                    ]),
                    "required": AnyCodable(["sessionId", "command"])
                ]
            ),
            execute: { args in
                guard let sessionID = args["sessionId"] as? String,
                      let command = args["command"] as? String else {
                    return "{\"ok\":false,\"error\":\"sessionId and command are required\"}"
                }
                let ok = TerminalService.shared.sendCommand(command, to: sessionID)
                return "{\"ok\":\(ok ? "true" : "false")}"
            }
        )
    }

    private var listTabs: MCPTool {
        MCPTool(
            name: "xatlas_tab_list",
            definition: MCPToolDefinition(
                name: "xatlas_tab_list",
                description: "List open tabs in the current project workspace",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([String: String]())
                ]
            ),
            execute: { _ in
                let tabs = Self.onMain { AppState.shared.tabs }.map { tab in
                    let kind: String
                    let attention: Bool
                    switch tab.kind {
                    case .terminal(let sessionID):
                        kind = "terminal"
                        attention = Self.onMain { AppState.shared.terminalRequiresAttention(sessionID) }
                    case .editor:
                        kind = "editor"
                        attention = false
                    }
                    let isSelected = Self.onMain { AppState.shared.selectedTab?.id == tab.id }
                    return "{\"id\":\"\(Self.escape(tab.id))\",\"title\":\"\(Self.escape(tab.title))\",\"kind\":\"\(kind)\",\"selected\":\(isSelected ? "true" : "false"),\"attention\":\(attention ? "true" : "false")}"
                }
                return "[\(tabs.joined(separator: ","))]"
            }
        )
    }

    private var selectTab: MCPTool {
        MCPTool(
            name: "xatlas_tab_select",
            definition: MCPToolDefinition(
                name: "xatlas_tab_select",
                description: "Select an open tab by tab ID",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "tabId": ["type": "string", "description": "Open tab ID"]
                    ]),
                    "required": AnyCodable(["tabId"])
                ]
            ),
            execute: { args in
                guard let tabID = args["tabId"] as? String,
                      let tab = Self.onMain({ AppState.shared.tabs.first(where: { $0.id == tabID }) }) else {
                    return "{\"ok\":false,\"error\":\"tabId not found\"}"
                }
                Self.onMain {
                    AppState.shared.selectedTab = tab
                }
                return "{\"ok\":true}"
            }
        )
    }

    private var closeTab: MCPTool {
        MCPTool(
            name: "xatlas_tab_close",
            definition: MCPToolDefinition(
                name: "xatlas_tab_close",
                description: "Close an open tab by tab ID",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "tabId": ["type": "string", "description": "Open tab ID"]
                    ]),
                    "required": AnyCodable(["tabId"])
                ]
            ),
            execute: { args in
                guard let tabID = args["tabId"] as? String,
                      let tab = Self.onMain({ AppState.shared.tabs.first(where: { $0.id == tabID }) }) else {
                    return "{\"ok\":false,\"error\":\"tabId not found\"}"
                }
                Self.onMain {
                    AppState.shared.closeTab(tab)
                }
                return "{\"ok\":true}"
            }
        )
    }

    private var snapshotTerminal: MCPTool {
        MCPTool(
            name: "xatlas_terminal_snapshot",
            definition: MCPToolDefinition(
                name: "xatlas_terminal_snapshot",
                description: "Read recent visible output from a terminal session",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "sessionId": ["type": "string", "description": "Tracked terminal session ID"],
                        "lines": ["type": "number", "description": "Number of lines to capture"]
                    ]),
                    "required": AnyCodable(["sessionId"])
                ]
            ),
            execute: { args in
                guard let sessionID = args["sessionId"] as? String else {
                    return "{\"ok\":false,\"error\":\"sessionId is required\"}"
                }
                let lines = args["lines"] as? Int ?? 200
                guard let snapshot = TerminalService.shared.snapshot(for: sessionID, lines: lines) else {
                    return "{\"ok\":false,\"error\":\"snapshot unavailable\"}"
                }
                return "{\"ok\":true,\"snapshot\":\"\(Self.escape(snapshot))\"}"
            }
        )
    }

    private var listProjects: MCPTool {
        MCPTool(
            name: "xatlas_project_list",
            definition: MCPToolDefinition(
                name: "xatlas_project_list",
                description: "List known projects and indicate which one is selected",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([String: String]())
                ]
            ),
            execute: { _ in
                let selectedProjectID = Self.onMain { AppState.shared.selectedProject?.id }
                let projects = Self.onMain { AppState.shared.projects }.map {
                    "{\"id\":\"\(Self.escape($0.id.uuidString))\",\"name\":\"\(Self.escape($0.name))\",\"path\":\"\(Self.escape($0.path))\",\"selected\":\($0.id == selectedProjectID ? "true" : "false")}"
                }
                return "[\(projects.joined(separator: ","))]"
            }
        )
    }

    private var addProject: MCPTool {
        MCPTool(
            name: "xatlas_project_add",
            definition: MCPToolDefinition(
                name: "xatlas_project_add",
                description: "Add a project to the app and select it",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "name": ["type": "string", "description": "Project display name"],
                        "path": ["type": "string", "description": "Absolute project path"]
                    ]),
                    "required": AnyCodable(["path"])
                ]
            ),
            execute: { args in
                guard let path = args["path"] as? String else {
                    return "{\"ok\":false,\"error\":\"path is required\"}"
                }
                let name = (args["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let displayName = name?.isEmpty == false ? name! : URL(fileURLWithPath: path).lastPathComponent
                Self.onMain {
                    AppState.shared.addProject(name: displayName, path: path)
                }
                return "{\"ok\":true,\"name\":\"\(Self.escape(displayName))\",\"path\":\"\(Self.escape(path))\"}"
            }
        )
    }

    private var selectProject: MCPTool {
        MCPTool(
            name: "xatlas_project_select",
            definition: MCPToolDefinition(
                name: "xatlas_project_select",
                description: "Select a project by UUID",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "projectId": ["type": "string", "description": "Project UUID"]
                    ]),
                    "required": AnyCodable(["projectId"])
                ]
            ),
            execute: { args in
                guard let rawProjectID = args["projectId"] as? String,
                      let projectID = Self.uuid(from: rawProjectID) else {
                    return "{\"ok\":false,\"error\":\"valid projectId is required\"}"
                }
                let ok = Self.onMain { AppState.shared.selectProject(id: projectID) }
                return "{\"ok\":\(ok ? "true" : "false")}"
            }
        )
    }

    private var removeProject: MCPTool {
        MCPTool(
            name: "xatlas_project_remove",
            definition: MCPToolDefinition(
                name: "xatlas_project_remove",
                description: "Remove a project by UUID",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "projectId": ["type": "string", "description": "Project UUID"]
                    ]),
                    "required": AnyCodable(["projectId"])
                ]
            ),
            execute: { args in
                guard let rawProjectID = args["projectId"] as? String,
                      let projectID = Self.uuid(from: rawProjectID),
                      let project = Self.onMain({ AppState.shared.projects.first(where: { $0.id == projectID }) }) else {
                    return "{\"ok\":false,\"error\":\"valid projectId is required\"}"
                }
                _ = Self.onMain {
                    AppState.shared.removeProject(project)
                }
                return "{\"ok\":true}"
            }
        )
    }

    private var showProjectSurface: MCPTool {
        MCPTool(
            name: "xatlas_project_surface",
            definition: MCPToolDefinition(
                name: "xatlas_project_surface",
                description: "Switch the projects section between workspace and dashboard",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "mode": ["type": "string", "description": "workspace or dashboard"]
                    ]),
                    "required": AnyCodable(["mode"])
                ]
            ),
            execute: { args in
                guard let mode = args["mode"] as? String else {
                    return "{\"ok\":false,\"error\":\"mode is required\"}"
                }
                switch mode {
                case "workspace":
                    Self.onMain {
                        AppState.shared.showProjectWorkspace()
                    }
                case "dashboard":
                    Self.onMain {
                        AppState.shared.showProjectDashboard()
                    }
                default:
                    return "{\"ok\":false,\"error\":\"mode must be workspace or dashboard\"}"
                }
                return "{\"ok\":true,\"mode\":\"\(Self.escape(mode))\"}"
            }
        )
    }

    private var showProjectQuickView: MCPTool {
        MCPTool(
            name: "xatlas_project_quick_view_open",
            definition: MCPToolDefinition(
                name: "xatlas_project_quick_view_open",
                description: "Open the dashboard quick-view sheet for a project",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "projectId": ["type": "string", "description": "Project UUID"]
                    ]),
                    "required": AnyCodable(["projectId"])
                ]
            ),
            execute: { args in
                guard let rawProjectID = args["projectId"] as? String,
                      let projectID = Self.uuid(from: rawProjectID) else {
                    return "{\"ok\":false,\"error\":\"valid projectId is required\"}"
                }
                let ok = Self.onMain {
                    AppState.shared.openProjectQuickView(id: projectID)
                }
                return "{\"ok\":\(ok ? "true" : "false")}"
            }
        )
    }

    private var closeProjectQuickView: MCPTool {
        MCPTool(
            name: "xatlas_project_quick_view_close",
            definition: MCPToolDefinition(
                name: "xatlas_project_quick_view_close",
                description: "Close the dashboard quick-view sheet if it is open",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([String: String]())
                ]
            ),
            execute: { _ in
                Self.onMain {
                    AppState.shared.closeProjectQuickView()
                }
                return "{\"ok\":true}"
            }
        )
    }

    private var projectBrief: MCPTool {
        MCPTool(
            name: "xatlas_project_brief",
            definition: MCPToolDefinition(
                name: "xatlas_project_brief",
                description: "Open a terminal in the project and ask the configured AI for a brief summary of the repo and latest commit",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "projectId": ["type": "string", "description": "Project UUID"],
                        "provider": ["type": "string", "description": "Optional provider override: builtIn, codex, claude, zai"]
                    ]),
                    "required": AnyCodable(["projectId"])
                ]
            ),
            execute: { args in
                guard let rawProjectID = args["projectId"] as? String,
                      let projectID = Self.uuid(from: rawProjectID),
                      let project = Self.onMain({ AppState.shared.projects.first(where: { $0.id == projectID }) }) else {
                    return "{\"ok\":false,\"error\":\"valid projectId is required\"}"
                }

                let provider: AISyncProvider?
                if let rawProvider = args["provider"] as? String {
                    provider = AISyncProvider(rawValue: rawProvider)
                } else {
                    provider = nil
                }

                guard let sessionID = Self.onMain({ AppState.shared.runProjectBrief(for: project, provider: provider) }) else {
                    return "{\"ok\":false,\"error\":\"failed to run project brief\"}"
                }
                return "{\"ok\":true,\"sessionId\":\"\(Self.escape(sessionID))\"}"
            }
        )
    }

    private var generateMCP: MCPTool {
        MCPTool(
            name: "xatlas_mcp_generate",
            definition: MCPToolDefinition(
                name: "xatlas_mcp_generate",
                description: "Generate an MCP server draft from a natural-language request",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "request": ["type": "string", "description": "Natural-language MCP request"],
                        "projectId": ["type": "string", "description": "Optional project UUID for context"],
                        "provider": ["type": "string", "description": "Optional provider override: builtIn, codex, claude, zai"]
                    ]),
                    "required": AnyCodable(["request"])
                ]
            ),
            execute: { args in
                guard let request = args["request"] as? String else {
                    return "{\"ok\":false,\"error\":\"request is required\"}"
                }

                let projectPath: String?
                if let rawProjectID = args["projectId"] as? String,
                   let projectID = Self.uuid(from: rawProjectID) {
                    projectPath = Self.onMain { AppState.shared.projects.first(where: { $0.id == projectID })?.path }
                } else {
                    projectPath = Self.onMain { AppState.shared.selectedProject?.path }
                }

                let provider = (args["provider"] as? String).flatMap(AISyncProvider.init(rawValue:))
                guard let draft = MCPAuthoringService.shared.generateDraft(from: request, provider: provider, projectPath: projectPath) else {
                    return "{\"ok\":false,\"error\":\"generation failed\"}"
                }

                let argsJSON = draft.args.map { "\"\(Self.escape($0))\"" }.joined(separator: ",")
                let envJSON = draft.env
                    .sorted { $0.key < $1.key }
                    .map { "\"\(Self.escape($0.key))\":\"\(Self.escape($0.value))\"" }
                    .joined(separator: ",")
                return "{\"ok\":true,\"draft\":{\"name\":\"\(Self.escape(draft.name))\",\"url\":\"\(Self.escape(draft.url))\",\"command\":\"\(Self.escape(draft.command))\",\"args\":[\(argsJSON)],\"env\":{\(envJSON)}}}"
            }
        )
    }

    private var addMCP: MCPTool {
        MCPTool(
            name: "xatlas_mcp_add",
            definition: MCPToolDefinition(
                name: "xatlas_mcp_add",
                description: "Install an MCP server into selected targets or all available targets",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "name": ["type": "string", "description": "Server name"],
                        "url": ["type": "string", "description": "HTTP MCP URL"],
                        "command": ["type": "string", "description": "stdio command"],
                        "args": ["type": "array", "description": "stdio args", "items": ["type": "string"]],
                        "env": ["type": "object", "description": "Environment variables"],
                        "targets": ["type": "array", "description": "Targets: codex, claude, project", "items": ["type": "string"]],
                        "projectId": ["type": "string", "description": "Optional project UUID"],
                        "allAvailable": ["type": "boolean", "description": "Install to all available targets"]
                    ]),
                    "required": AnyCodable(["name"])
                ]
            ),
            execute: { args in
                guard let name = args["name"] as? String else {
                    return "{\"ok\":false,\"error\":\"name is required\"}"
                }

                let projectPath: String?
                if let rawProjectID = args["projectId"] as? String,
                   let projectID = Self.uuid(from: rawProjectID) {
                    projectPath = Self.onMain { AppState.shared.projects.first(where: { $0.id == projectID })?.path }
                } else {
                    projectPath = Self.onMain { AppState.shared.selectedProject?.path }
                }

                let configuration = MCPConfiguration(
                    url: Self.trimmedOrNil(args["url"] as? String),
                    command: Self.trimmedOrNil(args["command"] as? String),
                    args: (args["args"] as? [Any])?.compactMap { "\($0)" } ?? [],
                    env: args["env"] as? [String: String] ?? [:]
                )

                let targets: [MCPInstallTarget]
                if args["allAvailable"] as? Bool == true {
                    targets = AgentCatalogService.shared.availableInstallTargets(projectPath: projectPath)
                } else if let rawTargets = args["targets"] as? [Any] {
                    targets = rawTargets.compactMap { value in
                        guard let raw = value as? String else { return nil }
                        return MCPInstallTarget(rawValue: raw)
                    }
                } else {
                    targets = AgentCatalogService.shared.availableInstallTargets(projectPath: projectPath)
                }

                let results = AgentCatalogService.shared.addMCP(
                    named: name,
                    configuration: configuration,
                    targets: targets,
                    projectPath: projectPath
                )
                let encoded = results
                    .map { "\"\($0.key.rawValue)\":\($0.value ? "true" : "false")" }
                    .joined(separator: ",")
                return "{\"ok\":true,\"results\":{\(encoded)}}"
            }
        )
    }

    private var workspaceState: MCPTool {
        MCPTool(
            name: "xatlas_workspace_state",
            definition: MCPToolDefinition(
                name: "xatlas_workspace_state",
                description: "Return current projects, terminal sessions, and current app selection",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([String: String]())
                ]
            ),
            execute: { _ in
                let selectedSessionID: String? = {
                    guard case .terminal(let sessionID) = Self.onMain({ AppState.shared.selectedTab?.kind }) else { return nil }
                    return sessionID
                }()
                let selectedProjectID = Self.onMain { AppState.shared.selectedProject?.id.uuidString ?? "" }
                let selectedTabID = Self.onMain { AppState.shared.selectedTab?.id ?? "" }
                let projectSurface = Self.onMain { AppState.shared.projectSurfaceMode.rawValue }
                let quickViewProjectID = Self.onMain { AppState.shared.dashboardQuickViewProjectID?.uuidString ?? "" }
                let operatorEvents = OperatorEventStore.shared.recentEvents(limit: 10)
                let iso = ISO8601DateFormatter()
                let projects = Self.onMain { AppState.shared.projects }.map {
                    "{\"id\":\"\(Self.escape($0.id.uuidString))\",\"name\":\"\(Self.escape($0.name))\",\"path\":\"\(Self.escape($0.path))\"}"
                }
                let sessions = TerminalService.shared.sessions.map {
                    "{\"id\":\"\(Self.escape($0.id))\",\"title\":\"\(Self.escape($0.displayTitle))\",\"tmuxSession\":\"\(Self.escape($0.tmuxSessionName))\",\"projectId\":\"\(Self.escape($0.projectID?.uuidString ?? ""))\",\"cwd\":\"\(Self.escape($0.currentDirectory ?? $0.workingDirectory ?? ""))\",\"state\":\"\(Self.escape($0.activityState.rawValue))\",\"attention\":\($0.requiresAttention ? "true" : "false"),\"lastCommand\":\"\(Self.escape($0.lastCommand ?? ""))\"}"
                }
                let eventSummary = operatorEvents.map {
                    "{\"id\":\"\(Self.escape($0.id.uuidString))\",\"timestamp\":\"\(Self.escape(iso.string(from: $0.timestamp)))\",\"kind\":\"\(Self.escape($0.kind.rawValue))\",\"sessionId\":\"\(Self.escape($0.sessionID))\",\"sessionTitle\":\"\(Self.escape($0.sessionTitle))\",\"projectId\":\"\(Self.escape($0.projectID?.uuidString ?? ""))\",\"command\":\"\(Self.escape($0.command))\",\"details\":\"\(Self.escape($0.details ?? ""))\"}"
                }
                return "{\"selectedProjectId\":\"\(Self.escape(selectedProjectID))\",\"selectedTabId\":\"\(Self.escape(selectedTabID))\",\"selectedSessionId\":\"\(Self.escape(selectedSessionID ?? ""))\",\"projectSurface\":\"\(Self.escape(projectSurface))\",\"quickViewProjectId\":\"\(Self.escape(quickViewProjectID))\",\"projects\":[\(projects.joined(separator: ","))],\"sessions\":[\(sessions.joined(separator: ","))],\"operatorEvents\":[\(eventSummary.joined(separator: ","))]}"
            }
        )
    }

    private static func uuid(from value: String?) -> UUID? {
        guard let value else { return nil }
        return UUID(uuidString: value)
    }

    private static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
    }

    private static func trimmedOrNil(_ value: String?) -> String? {
        guard let value else { return nil }
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }

    private static func onMain<T>(_ work: () -> T) -> T {
        if Thread.isMainThread {
            return work()
        }

        return DispatchQueue.main.sync(execute: work)
    }
}
