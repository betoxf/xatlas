import Foundation

final class MCPHandler {
    struct RequestContext {
        let protocolVersion: String
    }

    enum ResponseDisposition {
        case json(body: String, headers: [String: String] = [:])
        case accepted
    }

    static let supportedProtocolVersions = [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
    ]
    static let latestProtocolVersion = supportedProtocolVersions[0]

    private let decoder = JSONDecoder()
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = .sortedKeys
        return e
    }()

    func handle(json: String, context: RequestContext? = nil) -> ResponseDisposition {
        guard let data = json.data(using: .utf8),
              let request = try? decoder.decode(JSONRPCRequest.self, from: data) else {
            return .json(body: encodeError(id: nil, code: -32700, message: "Parse error"))
        }

        return handle(request: request, context: context)
    }

    func handle(request: JSONRPCRequest, context: RequestContext? = nil) -> ResponseDisposition {
        let context = context ?? RequestContext(protocolVersion: Self.latestProtocolVersion)
        switch request.method {
        case "initialize":
            return .json(
                body: encodeResult(id: request.id, result: [
                "protocolVersion": AnyCodable(context.protocolVersion),
                "capabilities": AnyCodable(["tools": [:]]),
                "serverInfo": AnyCodable(["name": "xatlas", "title": "xatlas CLE", "version": "0.1.0"])
                ])
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

    func protocolVersion(for request: JSONRPCRequest) -> String? {
        guard request.method == "initialize" else { return nil }
        guard let rawValue = request.params?["protocolVersion"]?.value as? String,
              !rawValue.isEmpty else {
            return Self.latestProtocolVersion
        }
        guard Self.supportedProtocolVersions.contains(rawValue) else {
            return nil
        }
        return rawValue
    }

    func unsupportedProtocolVersionResponse(id: JSONRPCID?, requestedVersion: String?) -> String {
        let requestedVersion = requestedVersion ?? "unknown"
        return encodeError(
            id: id,
            code: -32602,
            message: "Unsupported MCP protocol version '\(requestedVersion)'. Supported versions: \(Self.supportedProtocolVersions.joined(separator: ", "))"
        )
    }

    private func encodeResult(id: JSONRPCID?, result: [String: AnyCodable]) -> String {
        let response = JSONRPCResponse(id: id, result: AnyCodable(result), error: nil)
        guard let data = try? encoder.encode(response) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func encodeError(id: JSONRPCID?, code: Int, message: String) -> String {
        let response = JSONRPCResponse(id: id, result: nil, error: JSONRPCError(code: code, message: message))
        guard let data = try? encoder.encode(response) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
