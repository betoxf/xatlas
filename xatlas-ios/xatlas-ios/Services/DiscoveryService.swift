import Foundation
import Network

/// Discovers xatlas desktop instances on the local network via Bonjour.
@Observable
final class DiscoveryService: @unchecked Sendable {
    var discoveredHosts: [DiscoveredHost] = []
    var isSearching = false

    private var browser: NWBrowser?

    func startBrowsing() {
        guard browser == nil else { return }

        let params = NWParameters()
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: "_xatlas._tcp", domain: nil), using: params)

        b.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            let hosts = results.compactMap { result -> DiscoveredHost? in
                guard case .service(let name, _, _, _) = result.endpoint else { return nil }
                return DiscoveredHost(id: name, name: name, endpoint: result.endpoint)
            }
            DispatchQueue.main.async {
                self.discoveredHosts = hosts
            }
        }

        b.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            DispatchQueue.main.async {
                switch state {
                case .ready:
                    self.isSearching = true
                case .failed, .cancelled:
                    self.isSearching = false
                default:
                    break
                }
            }
        }

        b.start(queue: .global(qos: .userInitiated))
        browser = b
        isSearching = true
    }

    func stopBrowsing() {
        browser?.cancel()
        browser = nil
        isSearching = false
    }

    /// Resolve a Bonjour endpoint to an IP:port pair
    func resolve(_ host: DiscoveredHost) async -> (String, UInt16)? {
        await withCheckedContinuation { continuation in
            let connection = NWConnection(to: host.endpoint, using: .tcp)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if let path = connection.currentPath,
                       let endpoint = path.remoteEndpoint,
                       case .hostPort(let host, let port) = endpoint {
                        let ip: String
                        switch host {
                        case .ipv4(let addr):
                            ip = "\(addr)"
                        case .ipv6(let addr):
                            ip = "\(addr)"
                        default:
                            ip = "\(host)"
                        }
                        connection.cancel()
                        continuation.resume(returning: (ip, port.rawValue))
                    } else {
                        connection.cancel()
                        continuation.resume(returning: nil)
                    }
                case .failed, .cancelled:
                    continuation.resume(returning: nil)
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
        }
    }
}
