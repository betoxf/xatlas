import Foundation

struct FileTools: MCPToolSet {
    var tools: [MCPTool] {
        [readFile, writeFile, listDir]
    }

    private var readFile: MCPTool {
        MCPTool(
            name: "xatlas_file_read",
            definition: MCPToolDefinition(
                name: "xatlas_file_read",
                description: "Read file contents",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable(["path": ["type": "string", "description": "File path"]] as [String: [String: String]]),
                    "required": AnyCodable(["path"])
                ]
            ),
            execute: { args in
                guard let path = args["path"] as? String else { return "Error: path required" }
                do {
                    return try FileService.shared.readFile(at: path)
                } catch {
                    return "Error: \(error.localizedDescription)"
                }
            }
        )
    }

    private var writeFile: MCPTool {
        MCPTool(
            name: "xatlas_file_write",
            definition: MCPToolDefinition(
                name: "xatlas_file_write",
                description: "Write content to a file",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable([
                        "path": ["type": "string", "description": "File path"],
                        "content": ["type": "string", "description": "File content"]
                    ] as [String: [String: String]]),
                    "required": AnyCodable(["path", "content"])
                ]
            ),
            execute: { args in
                guard let path = args["path"] as? String,
                      let content = args["content"] as? String else { return "Error: path and content required" }
                do {
                    try FileService.shared.writeFile(at: path, content: content)
                    return "Written \(content.count) bytes to \(path)"
                } catch {
                    return "Error: \(error.localizedDescription)"
                }
            }
        )
    }

    private var listDir: MCPTool {
        MCPTool(
            name: "xatlas_file_list",
            definition: MCPToolDefinition(
                name: "xatlas_file_list",
                description: "List directory contents",
                inputSchema: [
                    "type": AnyCodable("object"),
                    "properties": AnyCodable(["path": ["type": "string", "description": "Directory path"]] as [String: [String: String]]),
                    "required": AnyCodable(["path"])
                ]
            ),
            execute: { args in
                guard let path = args["path"] as? String else { return "Error: path required" }
                do {
                    let items = try FileService.shared.listDirectory(at: path)
                    return items.joined(separator: "\n")
                } catch {
                    return "Error: \(error.localizedDescription)"
                }
            }
        )
    }
}
