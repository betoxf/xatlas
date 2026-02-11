import Foundation

struct TerminalTools: MCPToolSet {
    var tools: [MCPTool] {
        [createTerminal, listTerminals]
    }

    private var createTerminal: MCPTool {
        MCPTool(
            name: "xatlas_terminal_create",
            definition: MCPToolDefinition(
                name: "xatlas_terminal_create",
                description: "Create a new terminal session",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "name": ["type": "string", "description": "Terminal name"],
                        "cwd": ["type": "string", "description": "Working directory"]
                    ] as [String: [String: String]])
                ]
            ),
            execute: { args in
                let name = (args["name"] as? String) ?? "Terminal"
                let session = TerminalService.shared.createSession(title: name)
                return "{\"sessionId\": \"\(session.id)\", \"title\": \"\(session.title)\"}"
            }
        )
    }

    private var listTerminals: MCPTool {
        MCPTool(
            name: "xatlas_terminal_list",
            definition: MCPToolDefinition(
                name: "xatlas_terminal_list",
                description: "List all terminal sessions",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([String: String]())
                ]
            ),
            execute: { _ in
                let sessions = TerminalService.shared.sessions
                let list = sessions.map { "{\"id\":\"\($0.id)\",\"title\":\"\($0.title)\"}" }
                return "[\(list.joined(separator: ","))]"
            }
        )
    }
}
