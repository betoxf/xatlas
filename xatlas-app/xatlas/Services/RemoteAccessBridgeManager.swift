import Foundation

final class RemoteAccessBridgeManager: @unchecked Sendable {
    static let shared = RemoteAccessBridgeManager()
    private static let relayPortDefaultsKey = "xatlas.remoteAccessRelayPort"
    private static let relayIdentity = "xatlas-app"

    private struct RuntimePaths {
        let nodeExecutable: URL
        let relayDirectory: URL
        let relayServerScript: URL
        let bridgeDirectory: URL
        let bridgeCLIScript: URL
    }

    private let queue = DispatchQueue(label: "com.xatlas.remote-access-bridge")
    private let preferredRelayPorts = Array(9030...9035)
    private var relayProcess: Process?
    private var activeRelayPort: Int?
    private var isStarting = false

    private init() {}

    func startIfNeeded() {
        queue.async {
            self.startIfNeededInternal()
        }
    }

    func stop() {
        queue.async {
            self.stopInternal(stopBridgeService: true)
        }
    }

    func applicationWillTerminate() {
        queue.sync {
            self.stopInternal(stopBridgeService: true)
        }
    }

    private func startIfNeededInternal() {
        guard AppPreferences.shared.remoteAccessEnabled else {
            return
        }
        guard !isStarting else {
            return
        }

        isStarting = true
        defer { isStarting = false }

        do {
            let runtime = try resolveRuntimePaths()
            let relayPort = try ensureRelayRunning(runtime: runtime)
            let lanIP = try resolveLANIPAddress()
            let relayURL = "ws://\(lanIP):\(relayPort)/relay"

            try startBridgeService(runtime: runtime, relayURL: relayURL)
            print("[RemoteAccessBridge] bridge ready on \(relayURL)")
        } catch {
            print("[RemoteAccessBridge] \(error.localizedDescription)")
        }
    }

    private func stopInternal(stopBridgeService: Bool) {
        if stopBridgeService {
            do {
                let runtime = try resolveRuntimePaths()
                try runBridgeCLI(runtime: runtime, command: "stop", relayURL: nil)
            } catch {
                print("[RemoteAccessBridge] Failed to stop bridge service: \(error.localizedDescription)")
            }
        }

        terminateManagedRelayIfNeeded()
    }

    private func ensureRelayRunning(runtime: RuntimePaths) throws -> Int {
        if let relayProcess, !relayProcess.isRunning {
            self.relayProcess = nil
        }

        let candidatePorts = candidateRelayPorts()

        for port in candidatePorts where isRelayHealthy(port: port) {
            if activeRelayPort != port {
                terminateManagedRelayIfNeeded()
            }
            activeRelayPort = port
            persistRelayPort(port)
            return port
        }

        terminateManagedRelayIfNeeded()

        for port in candidatePorts {
            let process = Process()
            process.executableURL = runtime.nodeExecutable
            process.arguments = [runtime.relayServerScript.path]
            process.currentDirectoryURL = runtime.relayDirectory

            var environment = ProcessInfo.processInfo.environment
            environment["PORT"] = String(port)
            environment["XATLAS_RELAY_ID"] = Self.relayIdentity
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice

            try process.run()

            guard waitForRelayHealth(port: port, timeout: 5) else {
                if process.isRunning {
                    process.terminate()
                    process.waitUntilExit()
                }
                continue
            }

            relayProcess = process
            activeRelayPort = port
            persistRelayPort(port)
            return port
        }

        throw NSError(
            domain: "RemoteAccessBridgeManager",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The local relay failed to start on any xatlas relay port (\(candidatePorts.map(String.init).joined(separator: ", ")))."]
        )
    }

    private func terminateManagedRelayIfNeeded() {
        if let relayProcess {
            if relayProcess.isRunning {
                relayProcess.terminate()
                relayProcess.waitUntilExit()
            }
            self.relayProcess = nil
        }
    }

    private func candidateRelayPorts() -> [Int] {
        var ports: [Int] = []

        func append(_ port: Int?) {
            guard let port, isValidRelayPort(port), !ports.contains(port) else {
                return
            }
            ports.append(port)
        }

        let explicitRelayPort = resolveExplicitRelayPort()
        append(explicitRelayPort)
        if explicitRelayPort != nil {
            return ports
        }

        append(activeRelayPort)
        append(persistedRelayPort())
        preferredRelayPorts.forEach { append($0) }
        return ports
    }

    private func resolveExplicitRelayPort() -> Int? {
        let value = ProcessInfo.processInfo.environment["XATLAS_RELAY_PORT"]
        return parseRelayPort(value)
    }

    private func persistedRelayPort() -> Int? {
        let defaults = UserDefaults.standard
        guard let value = defaults.object(forKey: Self.relayPortDefaultsKey) else {
            return nil
        }

        if let port = value as? Int {
            return preferredRelayPorts.contains(port) ? port : nil
        }

        if let text = value as? String {
            let port = parseRelayPort(text)
            guard let port, preferredRelayPorts.contains(port) else {
                return nil
            }
            return port
        }

        return nil
    }

    private func persistRelayPort(_ port: Int) {
        UserDefaults.standard.set(port, forKey: Self.relayPortDefaultsKey)
    }

    private func parseRelayPort(_ value: String?) -> Int? {
        guard let value,
              let port = Int(value.trimmingCharacters(in: .whitespacesAndNewlines)),
              isValidRelayPort(port) else {
            return nil
        }
        return port
    }

    private func isValidRelayPort(_ port: Int) -> Bool {
        (1...65_535).contains(port)
    }

    private func startBridgeService(runtime: RuntimePaths, relayURL: String) throws {
        try runBridgeCLI(runtime: runtime, command: "start", relayURL: relayURL)
        guard waitForPairingSession(timeout: 10) else {
            throw NSError(
                domain: "RemoteAccessBridgeManager",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "The bridge service started, but no pairing session was published."]
            )
        }
    }

    private func runBridgeCLI(runtime: RuntimePaths, command: String, relayURL: String?) throws {
        let process = Process()
        process.executableURL = runtime.nodeExecutable
        process.arguments = [runtime.bridgeCLIScript.path, command]
        process.currentDirectoryURL = runtime.bridgeDirectory

        var environment = ProcessInfo.processInfo.environment
        if let relayURL {
            environment["XATLAS_RELAY"] = relayURL
        }
        process.environment = environment

        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = outputPipe

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: outputData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let description = output?.isEmpty == false
                ? output!
                : "The bridge command `\(command)` failed with exit code \(process.terminationStatus)."
            throw NSError(
                domain: "RemoteAccessBridgeManager",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: description]
            )
        }
    }

    private func resolveRuntimePaths() throws -> RuntimePaths {
        let fileManager = FileManager.default
        let bridgeRelativePath = "xatlas-bridge/bin/xatlas-bridge.js"
        let relayRelativePath = "relay/server.js"

        for root in candidateSearchRoots() {
            let directBridge = root.appendingPathComponent(bridgeRelativePath)
            let directRelay = root.appendingPathComponent(relayRelativePath)
            if fileManager.fileExists(atPath: directBridge.path),
               fileManager.fileExists(atPath: directRelay.path) {
                return try makeRuntimePaths(
                    bridgeScript: directBridge,
                    relayScript: directRelay
                )
            }

            let siblingRoot = root.deletingLastPathComponent()
            let siblingBridge = siblingRoot.appendingPathComponent(bridgeRelativePath)
            let siblingRelay = siblingRoot.appendingPathComponent(relayRelativePath)
            if fileManager.fileExists(atPath: siblingBridge.path),
               fileManager.fileExists(atPath: siblingRelay.path) {
                return try makeRuntimePaths(
                    bridgeScript: siblingBridge,
                    relayScript: siblingRelay
                )
            }
        }

        throw NSError(
            domain: "RemoteAccessBridgeManager",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Could not find bundled xatlas bridge resources."]
        )
    }

    private func makeRuntimePaths(bridgeScript: URL, relayScript: URL) throws -> RuntimePaths {
        guard let nodeExecutable = resolveNodeExecutable() else {
            throw NSError(
                domain: "RemoteAccessBridgeManager",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Could not find a Node.js executable for the bundled relay bridge."]
            )
        }

        return RuntimePaths(
            nodeExecutable: nodeExecutable,
            relayDirectory: relayScript.deletingLastPathComponent(),
            relayServerScript: relayScript,
            bridgeDirectory: bridgeScript.deletingLastPathComponent().deletingLastPathComponent(),
            bridgeCLIScript: bridgeScript
        )
    }

    private func candidateSearchRoots() -> [URL] {
        var urls: [URL] = []
        var seen = Set<String>()

        func add(_ url: URL?) {
            guard let url else { return }
            let standardized = url.standardizedFileURL
            guard seen.insert(standardized.path).inserted else { return }
            urls.append(standardized)
        }

        add(Bundle.main.resourceURL)
        add(URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true))

        var current = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        for _ in 0..<8 {
            add(current)
            let parent = current.deletingLastPathComponent()
            if parent.path == current.path {
                break
            }
            current = parent
        }

        return urls
    }

    private func resolveNodeExecutable() -> URL? {
        let fileManager = FileManager.default
        let environment = ProcessInfo.processInfo.environment
        let explicitPath = environment["XATLAS_NODE_PATH"]
        let candidates = [
            explicitPath,
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ].compactMap { $0 }

        for candidate in candidates where fileManager.isExecutableFile(atPath: candidate) {
            return URL(fileURLWithPath: candidate)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v node"]
        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            return nil
        }

        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: outputData, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              fileManager.isExecutableFile(atPath: output) else {
            return nil
        }

        return URL(fileURLWithPath: output)
    }

    private func resolveLANIPAddress() throws -> String {
        guard let address = MCPServer.lanIPAddress(), !address.isEmpty else {
            throw NSError(
                domain: "RemoteAccessBridgeManager",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Could not determine the current LAN IP address for relay pairing."]
            )
        }
        return address
    }

    private func waitForRelayHealth(port: Int, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isRelayHealthy(port: port) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    private func waitForPairingSession(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        let pairingSessionURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".xatlas", isDirectory: true)
            .appendingPathComponent("pairing-session.json", isDirectory: false)

        while Date() < deadline {
            if let data = try? Data(contentsOf: pairingSessionURL),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               json["pairingPayload"] as? [String: Any] != nil {
                return true
            }
            Thread.sleep(forTimeInterval: 0.2)
        }

        return false
    }

    private func isRelayHealthy(port: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["ok"] as? Bool == true else {
            return false
        }

        if let relayID = json["relayId"] as? String, relayID == Self.relayIdentity {
            return true
        }

        return false
    }
}
