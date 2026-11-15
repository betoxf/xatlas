import Foundation

/// A remote control link from the pairing code xatlas shows on the Mac:
/// `https://<host>/remote/v4?sid=…&hash=…&t=…&mid=…&name=…&app_version=…`.
/// `hash` is the pairing secret, so the link is stored in the Keychain.
struct RemoteLink: Codable, Hashable, Sendable {
    let url: URL
    /// The Mac's name, when the link carries one.
    let deviceName: String?
    /// SHA-256 of the certificate the Mac serves the remote with (lowercase hex), when it
    /// serves it itself: the only certificate the app accepts for that address.
    let certificateFingerprint: String?

    init?(string: String) {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            let components = URLComponents(string: trimmed),
            let host = components.host, !host.isEmpty,
            let scheme = components.scheme?.lowercased(),
            scheme == "https" || (scheme == "http" && Self.isLocalNetworkHost(host)),
            let url = components.url
        else { return nil }

        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            guard let value = items.first(where: { $0.name == name })?.value, !value.isEmpty else { return nil }
            return value
        }
        guard value("sid") != nil, value("hash") != nil, value("t") != nil else { return nil }

        self.url = url
        self.deviceName = value("name")
        self.certificateFingerprint = value("fp").flatMap { fingerprint in
            let normalized = fingerprint.lowercased()
            let isHex = normalized.count == 64 && normalized.allSatisfy(\.isHexDigit)
            return isHex ? normalized : nil
        }
    }

    /// The Mac's name for display, without the `.local` hostname suffix.
    var displayName: String? {
        guard let deviceName else { return nil }
        return deviceName.hasSuffix(".local") ? String(deviceName.dropLast(".local".count)) : deviceName
    }

    /// The app's own links: `xatlas://remote?link=<percent-encoded remote control link>`.
    init?(appURL: URL) {
        guard
            appURL.scheme?.lowercased() == "xatlas",
            appURL.host?.lowercased() == "remote",
            let link = URLComponents(url: appURL, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "link" })?.value
        else { return nil }
        self.init(string: link)
    }

    /// Pages of the same origin load inside the app; anything else opens in Safari.
    func isSameOrigin(_ other: URL) -> Bool {
        other.scheme?.lowercased() == url.scheme?.lowercased()
            && other.host?.lowercased() == url.host?.lowercased()
            && other.port == url.port
    }

    /// Plain http only reaches a Mac on the local network or the user's own Tailscale network,
    /// where the desktop app serves the remote itself.
    static func isLocalNetworkHost(_ host: String) -> Bool {
        let host = host.lowercased()
        if host == "localhost" || host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        switch (octets[0], octets[1]) {
        case (127, _), (10, _), (192, 168), (172, 16...31), (100, 64...127), (169, 254): return true
        default: return false
        }
    }
}
