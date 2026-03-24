// FILE: CodexService+Tools.swift
// Purpose: Generic MCP tool-call helpers for runtimes that expose functionality through tools/call.
// Layer: Service
// Exports: CodexService tool helpers
// Depends on: Foundation, JSONValue

import Foundation

extension CodexService {
    func callTool(name: String, arguments: [String: JSONValue] = [:]) async throws -> String {
        let response = try await sendRequest(
            method: "tools/call",
            params: .object([
                "name": .string(name),
                "arguments": .object(arguments),
            ])
        )

        guard let resultObject = response.result?.objectValue,
              let contentItems = resultObject["content"]?.arrayValue else {
            throw CodexServiceError.invalidResponse("tools/call response missing content")
        }

        let texts = contentItems.compactMap { item in
            item.objectValue?["text"]?.stringValue
        }
        guard !texts.isEmpty else {
            throw CodexServiceError.invalidResponse("tools/call response missing text")
        }

        return texts.joined(separator: "\n")
    }
}
