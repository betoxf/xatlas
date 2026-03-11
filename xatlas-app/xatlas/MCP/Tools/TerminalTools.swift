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
                let cwd = args["cwd"] as? String
                let projectID = Self.uuid(from: args["projectId"] as? String) ?? AppState.shared.selectedProject?.id
                let select = args["select"] as? Bool ?? true

                let session = TerminalService.shared.createSession(title: name, projectID: projectID, workingDirectory: cwd)
                if select {
                    _ = AppState.shared.openTerminalSession(session.id)
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
                let ok = AppState.shared.openTerminalSession(sessionID)
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
                        "killTmux": ["type": "boolean", "description": "Also kill the backing tmux session"]
                    ]),
                    "required": AnyCodable(["sessionId"])
                ]
            ),
            execute: { args in
                guard let sessionID = args["sessionId"] as? String else {
                    return "{\"ok\":false,\"error\":\"sessionId is required\"}"
                }
                let killTmux = args["killTmux"] as? Bool ?? false
                let ok = AppState.shared.closeTerminalSession(sessionID, killTmux: killTmux)
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
                    guard case .terminal(let sessionID) = AppState.shared.selectedTab?.kind else { return nil }
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
                let tabs = AppState.shared.tabs.map { tab in
                    let kind: String
                    let attention: Bool
                    switch tab.kind {
                    case .terminal(let sessionID):
                        kind = "terminal"
                        attention = AppState.shared.terminalRequiresAttention(sessionID)
                    case .editor:
                        kind = "editor"
                        attention = false
                    }
                    return "{\"id\":\"\(Self.escape(tab.id))\",\"title\":\"\(Self.escape(tab.title))\",\"kind\":\"\(kind)\",\"selected\":\(AppState.shared.selectedTab?.id == tab.id ? "true" : "false"),\"attention\":\(attention ? "true" : "false")}"
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
                      let tab = AppState.shared.tabs.first(where: { $0.id == tabID }) else {
                    return "{\"ok\":false,\"error\":\"tabId not found\"}"
                }
                AppState.shared.selectedTab = tab
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
                      let tab = AppState.shared.tabs.first(where: { $0.id == tabID }) else {
                    return "{\"ok\":false,\"error\":\"tabId not found\"}"
                }
                AppState.shared.closeTab(tab)
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
                let selectedProjectID = AppState.shared.selectedProject?.id
                let projects = AppState.shared.projects.map {
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
                AppState.shared.addProject(name: displayName, path: path)
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
                let ok = AppState.shared.selectProject(id: projectID)
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
                      let project = AppState.shared.projects.first(where: { $0.id == projectID }) else {
                    return "{\"ok\":false,\"error\":\"valid projectId is required\"}"
                }
                AppState.shared.removeProject(project)
                return "{\"ok\":true}"
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
                    guard case .terminal(let sessionID) = AppState.shared.selectedTab?.kind else { return nil }
                    return sessionID
                }()
                let projects = AppState.shared.projects.map {
                    "{\"id\":\"\(Self.escape($0.id.uuidString))\",\"name\":\"\(Self.escape($0.name))\",\"path\":\"\(Self.escape($0.path))\"}"
                }
                let sessions = TerminalService.shared.sessions.map {
                    "{\"id\":\"\(Self.escape($0.id))\",\"title\":\"\(Self.escape($0.displayTitle))\",\"tmuxSession\":\"\(Self.escape($0.tmuxSessionName))\",\"projectId\":\"\(Self.escape($0.projectID?.uuidString ?? ""))\",\"cwd\":\"\(Self.escape($0.currentDirectory ?? $0.workingDirectory ?? ""))\",\"state\":\"\(Self.escape($0.activityState.rawValue))\"}"
                }
                return "{\"selectedProjectId\":\"\(Self.escape(AppState.shared.selectedProject?.id.uuidString ?? ""))\",\"selectedTabId\":\"\(Self.escape(AppState.shared.selectedTab?.id ?? ""))\",\"selectedSessionId\":\"\(Self.escape(selectedSessionID ?? ""))\",\"projects\":[\(projects.joined(separator: ","))],\"sessions\":[\(sessions.joined(separator: ","))]}"
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
}
