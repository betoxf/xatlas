import Foundation

final class MCPHandler {
    enum ResponseDisposition {
        case json(body: String, headers: [String: String] = [:])
        case accepted
    }

    private let decoder = JSONDecoder()
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = .sortedKeys
        return e
    }()

    func handle(json: String) -> ResponseDisposition {
        guard let data = json.data(using: .utf8),
              let request = try? decoder.decode(JSONRPCRequest.self, from: data) else {
            return .json(body: encodeError(id: nil, code: -32700, message: "Parse error"))
        }

        switch request.method {
        case "initialize":
            return .json(
                body: encodeResult(id: request.id, result: [
                "protocolVersion": AnyCodable("2024-11-05"),
                "capabilities": AnyCodable(["tools": ["listChanged": true]]),
                "serverInfo": AnyCodable(["name": "xatlas", "version": "0.1.0"])
                ]),
                headers: ["MCP-Session-Id": UUID().uuidString]
            )

        case "notifications/initialized":
            return .accepted

        case let method where request.id == nil && method.hasPrefix("notifications/"):
            return .accepted

        case "tools/list":
            let tools = ToolRegistry.shared.allDefinitions()
            return .json(body: encodeResult(id: request.id, result: ["tools": AnyCodable(tools.map { [
                "name": AnyCodable($0.name),
                "description": AnyCodable($0.description),
                "inputSchema": AnyCodable($0.inputSchema)
            ] as [String: AnyCodable] })]))

        case "tools/call":
            let params = request.params ?? [:]
            let toolName = (params["name"]?.value as? String) ?? ""
            let args = (params["arguments"]?.value as? [String: Any]) ?? [:]
            let result = ToolRegistry.shared.call(tool: toolName, arguments: args)
            return .json(body: encodeResult(id: request.id, result: [
                "content": AnyCodable([["type": "text", "text": result]])
            ]))

        default:
            if request.id == nil {
                return .accepted
            }
            return .json(body: encodeError(id: request.id, code: -32601, message: "Method not found: \(request.method)"))
        }
    }

    private func encodeResult(id: Int?, result: [String: AnyCodable]) -> String {
        let response = JSONRPCResponse(id: id, result: AnyCodable(result), error: nil)
        guard let data = try? encoder.encode(response) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func encodeError(id: Int?, code: Int, message: String) -> String {
        let response = JSONRPCResponse(id: id, result: nil, error: JSONRPCError(code: code, message: message))
        guard let data = try? encoder.encode(response) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
