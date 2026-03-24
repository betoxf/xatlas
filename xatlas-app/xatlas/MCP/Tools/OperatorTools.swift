import Foundation

struct OperatorTools: MCPToolSet {
    var tools: [MCPTool] {
        [
            operatorFeed,
            operatorOpenTerminal,
            operatorRetry,
            operatorClearAttention,
        ]
    }

    private var operatorFeed: MCPTool {
        MCPTool(
            name: "xatlas_operator_feed",
            definition: MCPToolDefinition(
                name: "xatlas_operator_feed",
                description: "List recent operator events across projects, including command starts, completions, and failures",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "limit": ["type": "number", "description": "Maximum number of events to return"]
                    ])
                ]
            ),
            execute: { args in
                let limit = max(1, min(args["limit"] as? Int ?? 40, 200))
                let projectsByID = Dictionary(uniqueKeysWithValues: MainThread.run { AppState.shared.projects }.map { ($0.id, $0.name) })
                let events = OperatorEventStore.shared.recentEvents(limit: limit).map { event in
                    let projectName = event.projectID.flatMap { projectsByID[$0] } ?? ""
                    let details = event.details ?? ""
                    return "{\"id\":\"\(Self.escape(event.id.uuidString))\",\"timestamp\":\"\(Self.escape(ISO8601DateFormatter().string(from: event.timestamp)))\",\"kind\":\"\(Self.escape(event.kind.rawValue))\",\"projectId\":\"\(Self.escape(event.projectID?.uuidString ?? ""))\",\"projectName\":\"\(Self.escape(projectName))\",\"sessionId\":\"\(Self.escape(event.sessionID))\",\"sessionTitle\":\"\(Self.escape(event.sessionTitle))\",\"command\":\"\(Self.escape(event.command))\",\"details\":\"\(Self.escape(details))\"}"
                }
                return "[\(events.joined(separator: ","))]"
            }
        )
    }

    private var operatorOpenTerminal: MCPTool {
        MCPTool(
            name: "xatlas_operator_open_terminal",
            definition: MCPToolDefinition(
                name: "xatlas_operator_open_terminal",
                description: "Open and select the terminal for a session referenced by the operator feed",
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
                let ok = MainThread.run { AppState.shared.openTerminalSession(sessionID) }
                return "{\"ok\":\(ok ? "true" : "false")}"
            }
        )
    }

    private var operatorRetry: MCPTool {
        MCPTool(
            name: "xatlas_operator_retry",
            definition: MCPToolDefinition(
                name: "xatlas_operator_retry",
                description: "Retry the most recent command for a terminal session",
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
                let ok = MainThread.run { AppState.shared.retryLastCommand(for: sessionID) }
                return "{\"ok\":\(ok ? "true" : "false")}"
            }
        )
    }

    private var operatorClearAttention: MCPTool {
        MCPTool(
            name: "xatlas_operator_clear_attention",
            definition: MCPToolDefinition(
                name: "xatlas_operator_clear_attention",
                description: "Clear the attention badge for a terminal session",
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
                let ok = MainThread.run { AppState.shared.clearAttention(for: sessionID) }
                return "{\"ok\":\(ok ? "true" : "false")}"
            }
        )
    }

    private static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
    }
}

private enum MainThread {
    static func run<T>(_ work: () -> T) -> T {
        if Thread.isMainThread {
            return work()
        }
        return DispatchQueue.main.sync(execute: work)
    }
}
