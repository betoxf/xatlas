import Foundation

// MARK: - JSON-RPC

struct JSONRPCRequest: Codable {
    let jsonrpc: String
    let id: Int?
    let method: String
    let params: [String: AnyCodable]?
}

struct JSONRPCResponse: Codable {
    let jsonrpc: String
    let id: Int?
    let result: AnyCodable?
    let error: JSONRPCError?

    init(id: Int?, result: AnyCodable?, error: JSONRPCError?) {
        self.jsonrpc = "2.0"
        self.id = id
        self.result = result
        self.error = error
    }
}

struct JSONRPCError: Codable {
    let code: Int
    let message: String
}

// MARK: - MCP Types

struct MCPToolDefinition: Codable {
    let name: String
    let description: String
    let inputSchema: [String: AnyCodable]
}

struct MCPToolResult: Codable {
    let content: [MCPContent]
    let isError: Bool?
}

struct MCPContent: Codable {
    let type: String
    let text: String?
}

// MARK: - AnyCodable helper

struct AnyCodable: Codable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = NSNull() }
        else if let b = try? container.decode(Bool.self) { value = b }
        else if let i = try? container.decode(Int.self) { value = i }
        else if let d = try? container.decode(Double.self) { value = d }
        else if let s = try? container.decode(String.self) { value = s }
        else if let a = try? container.decode([AnyCodable].self) { value = a.map(\.value) }
        else if let o = try? container.decode([String: AnyCodable].self) { value = o.mapValues(\.value) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type") }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull: try container.encodeNil()
        case let b as Bool: try container.encode(b)
        case let i as Int: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let s as String: try container.encode(s)
        case let a as [AnyCodable]: try container.encode(a)
        case let o as [String: AnyCodable]: try container.encode(o)
        case let a as [Any]: try container.encode(a.map { AnyCodable($0) })
        case let o as [String: Any]: try container.encode(o.mapValues { AnyCodable($0) })
        default: try container.encodeNil()
        }
    }
}
