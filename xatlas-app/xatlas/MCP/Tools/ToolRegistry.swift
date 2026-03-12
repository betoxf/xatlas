import Foundation

final class ToolRegistry {
    nonisolated(unsafe) static let shared = ToolRegistry()

    private var tools: [String: MCPTool] = [:]

    private init() {
        register(TerminalTools())
        register(OperatorTools())
        register(FileTools())
    }

    private func register(_ toolSet: MCPToolSet) {
        for tool in toolSet.tools {
            tools[tool.name] = tool
        }
    }

    func allDefinitions() -> [MCPToolDefinition] {
        tools.values.map { $0.definition }
    }

    func call(tool name: String, arguments: [String: Any]) -> String {
        guard let tool = tools[name] else {
            return "Error: Unknown tool '\(name)'"
        }
        return tool.execute(arguments)
    }
}

protocol MCPToolSet {
    var tools: [MCPTool] { get }
}

struct MCPTool {
    let name: String
    let definition: MCPToolDefinition
    let execute: ([String: Any]) -> String
}
