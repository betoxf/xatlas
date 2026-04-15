import Foundation

/// All configurable fields for a single MCP server entry. Fields are
/// optional because different transports and providers populate different
/// subsets; `rawJSONObject` preserves any additional keys we don't model
/// explicitly so round-tripping doesn't drop them.
struct MCPConfiguration {
    let url: String?
    let command: String?
    let args: [String]
    let env: [String: String]
    let cwd: String?
    let enabled: Bool?
    let required: Bool?
    let enabledTools: [String]
    let disabledTools: [String]
    let envVars: [String]
    let bearerTokenEnvVar: String?
    let httpHeaders: [String: String]
    let envHTTPHeaders: [String: String]
    let scopes: [String]
    let oauthResource: String?
    let startupTimeoutSec: Double?
    let startupTimeoutMS: Int?
    let toolTimeoutSec: Double?
    let rawJSONObject: [String: Any]?

    init(
        url: String? = nil,
        command: String? = nil,
        args: [String] = [],
        env: [String: String] = [:],
        cwd: String? = nil,
        enabled: Bool? = nil,
        required: Bool? = nil,
        enabledTools: [String] = [],
        disabledTools: [String] = [],
        envVars: [String] = [],
        bearerTokenEnvVar: String? = nil,
        httpHeaders: [String: String] = [:],
        envHTTPHeaders: [String: String] = [:],
        scopes: [String] = [],
        oauthResource: String? = nil,
        startupTimeoutSec: Double? = nil,
        startupTimeoutMS: Int? = nil,
        toolTimeoutSec: Double? = nil,
        rawJSONObject: [String: Any]? = nil
    ) {
        self.url = url
        self.command = command
        self.args = args
        self.env = env
        self.cwd = cwd
        self.enabled = enabled
        self.required = required
        self.enabledTools = enabledTools
        self.disabledTools = disabledTools
        self.envVars = envVars
        self.bearerTokenEnvVar = bearerTokenEnvVar
        self.httpHeaders = httpHeaders
        self.envHTTPHeaders = envHTTPHeaders
        self.scopes = scopes
        self.oauthResource = oauthResource
        self.startupTimeoutSec = startupTimeoutSec
        self.startupTimeoutMS = startupTimeoutMS
        self.toolTimeoutSec = toolTimeoutSec
        self.rawJSONObject = rawJSONObject
    }

    var transportSummary: String {
        if url != nil { return "HTTP" }
        if command != nil { return "stdio" }
        return "configured"
    }

    var detailSummary: String {
        if let url, !url.isEmpty {
            return url
        }

        let pieces = [command] + args
        return pieces.compactMap { $0 }.joined(separator: " ")
    }

    /// Round-trip representation suitable for serializing back to disk.
    /// Preserves any unknown keys carried in `rawJSONObject`.
    var jsonObject: [String: Any] {
        var object = rawJSONObject ?? [:]
        setJSONValue(&object, key: "url", value: url)
        setJSONValue(&object, key: "command", value: command)
        setJSONValue(&object, key: "args", value: args.isEmpty ? nil : args)
        setJSONValue(&object, key: "env", value: env.isEmpty ? nil : env)
        setJSONValue(&object, key: "cwd", value: cwd)
        setJSONValue(&object, key: "enabled", value: enabled)
        setJSONValue(&object, key: "required", value: required)
        setJSONValue(&object, key: "enabledTools", value: enabledTools.isEmpty ? nil : enabledTools)
        setJSONValue(&object, key: "disabledTools", value: disabledTools.isEmpty ? nil : disabledTools)
        setJSONValue(&object, key: "envVars", value: envVars.isEmpty ? nil : envVars)
        setJSONValue(&object, key: "bearerTokenEnvVar", value: bearerTokenEnvVar)
        setJSONValue(&object, key: "httpHeaders", value: httpHeaders.isEmpty ? nil : httpHeaders)
        setJSONValue(&object, key: "envHttpHeaders", value: envHTTPHeaders.isEmpty ? nil : envHTTPHeaders)
        setJSONValue(&object, key: "scopes", value: scopes.isEmpty ? nil : scopes)
        setJSONValue(&object, key: "oauthResource", value: oauthResource)
        setJSONValue(&object, key: "startupTimeoutSec", value: startupTimeoutSec)
        setJSONValue(&object, key: "startupTimeoutMs", value: startupTimeoutMS)
        setJSONValue(&object, key: "toolTimeoutSec", value: toolTimeoutSec)
        return object
    }

    private func setJSONValue(_ object: inout [String: Any], key: String, value: Any?) {
        if let value {
            object[key] = value
        } else {
            object.removeValue(forKey: key)
        }
    }
}
