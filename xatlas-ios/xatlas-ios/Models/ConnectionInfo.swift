import Foundation
import Network

/// Connection phase for the app's navigation state
enum ConnectionPhase: Equatable {
    case discovering
    case pairing(DiscoveredHost)
    case connected
}

/// A desktop host discovered via Bonjour
struct DiscoveredHost: Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let endpoint: NWEndpoint

    static func == (lhs: DiscoveredHost, rhs: DiscoveredHost) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

/// Stored connection info after successful pairing
struct ConnectionInfo: Codable {
    let host: String
    let port: Int
    let streamPort: Int
    let token: String
    let hostName: String
}

/// Root app connection state
@Observable
final class AppConnectionState {
    var phase: ConnectionPhase = .discovering
    var connectionInfo: ConnectionInfo?
    var workspaceState: RemoteWorkspaceState = .empty
    var isPolling = false

    func connect(info: ConnectionInfo) {
        connectionInfo = info
        phase = .connected
    }

    func disconnect() {
        connectionInfo = nil
        workspaceState = .empty
        isPolling = false
        phase = .discovering
    }
}
