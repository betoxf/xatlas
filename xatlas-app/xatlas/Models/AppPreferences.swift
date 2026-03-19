import Foundation

enum AISyncProvider: String, CaseIterable, Identifiable {
    case builtIn
    case codex
    case claude
    case zai

    var id: String { rawValue }

    var label: String {
        switch self {
        case .builtIn: return "Built-in"
        case .codex: return "Codex"
        case .claude: return "Claude Code"
        case .zai: return "Zai"
        }
    }
}

@Observable
final class AppPreferences {
    nonisolated(unsafe) static let shared = AppPreferences()

    var syncProvider: AISyncProvider {
        didSet { defaults.set(syncProvider.rawValue, forKey: Keys.syncProvider) }
    }

    var useAIForSync: Bool {
        didSet { defaults.set(useAIForSync, forKey: Keys.useAIForSync) }
    }

    var pushAfterSync: Bool {
        didSet { defaults.set(pushAfterSync, forKey: Keys.pushAfterSync) }
    }

    var remoteAccessEnabled: Bool {
        didSet { defaults.set(remoteAccessEnabled, forKey: Keys.remoteAccessEnabled) }
    }

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let syncProvider = "xatlas.syncProvider"
        static let useAIForSync = "xatlas.useAIForSync"
        static let pushAfterSync = "xatlas.pushAfterSync"
        static let remoteAccessEnabled = "xatlas.remoteAccessEnabled"
    }

    private init() {
        syncProvider = AISyncProvider(rawValue: defaults.string(forKey: Keys.syncProvider) ?? "") ?? .codex
        useAIForSync = defaults.object(forKey: Keys.useAIForSync) as? Bool ?? true
        pushAfterSync = defaults.object(forKey: Keys.pushAfterSync) as? Bool ?? true
        remoteAccessEnabled = defaults.object(forKey: Keys.remoteAccessEnabled) as? Bool ?? false
    }
}
