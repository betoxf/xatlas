import Foundation
import Security

/// Keeps the paired Mac's link in the Keychain, on this device only.
struct PairingStore: Sendable {
    var service = "com.xatlas.ios.pairing"
    var account = "remote-link"

    func load() -> RemoteLink? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return try? JSONDecoder().decode(RemoteLink.self, from: data)
    }

    func save(_ link: RemoteLink) throws {
        clear()
        var item = baseQuery
        item[kSecValueData as String] = try JSONEncoder().encode(link)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
