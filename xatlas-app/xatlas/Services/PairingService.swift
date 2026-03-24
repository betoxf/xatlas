import Foundation

struct PairedDevice: Codable, Identifiable {
    let token: String
    let deviceName: String
    let deviceId: String
    let pairedAt: Date

    var id: String { token }
}

final class PairingService: @unchecked Sendable {
    nonisolated(unsafe) static let shared = PairingService()

    private(set) var pairingCode: String
    private(set) var pairedDevices: [PairedDevice] = []
    private let lock = NSLock()

    private let persistURL: URL = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support", isDirectory: true)
        return support
            .appendingPathComponent("xatlas", isDirectory: true)
            .appendingPathComponent("paired-devices.json", isDirectory: false)
    }()

    private init() {
        pairingCode = Self.generateCode()
        loadDevices()
    }

    // MARK: - Pairing code

    func regenerateCode() {
        lock.lock()
        pairingCode = Self.generateCode()
        lock.unlock()
    }

    private static func generateCode() -> String {
        String(format: "%06d", Int.random(in: 0...999999))
    }

    // MARK: - Token management

    func pair(code: String, deviceName: String, deviceId: String) -> String? {
        lock.lock()
        defer { lock.unlock() }

        guard code == pairingCode else { return nil }

        // Remove existing pairing for this device
        pairedDevices.removeAll { $0.deviceId == deviceId }

        let token = UUID().uuidString
        let device = PairedDevice(token: token, deviceName: deviceName, deviceId: deviceId, pairedAt: .now)
        pairedDevices.append(device)
        saveDevices()

        // Regenerate code after successful pairing
        pairingCode = Self.generateCode()

        return token
    }

    func isValid(token: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return pairedDevices.contains { $0.token == token }
    }

    func revoke(token: String) {
        lock.lock()
        pairedDevices.removeAll { $0.token == token }
        saveDevices()
        lock.unlock()
    }

    func revokeAll() {
        lock.lock()
        pairedDevices.removeAll()
        saveDevices()
        lock.unlock()
    }

    // MARK: - Persistence

    private func loadDevices() {
        guard let data = try? Data(contentsOf: persistURL),
              let devices = try? JSONDecoder().decode([PairedDevice].self, from: data) else { return }
        pairedDevices = devices
    }

    private func saveDevices() {
        let dir = persistURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(pairedDevices) {
            try? data.write(to: persistURL, options: .atomic)
        }
    }
}
