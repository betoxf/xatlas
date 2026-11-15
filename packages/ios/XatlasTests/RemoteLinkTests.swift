import Foundation
import Testing
@testable import xatlas

struct RemoteLinkTests {
    private let pairing = "https://remote.example.com/remote/v4?sid=xd_1&hash=abc%3D&t=1760000000000&mid=m1&name=Studio%20Mac"

    @Test func readsAPairingLink() throws {
        let link = try #require(RemoteLink(string: "  \(pairing)\n"))
        #expect(link.url.host == "remote.example.com")
        #expect(link.deviceName == "Studio Mac")
    }

    @Test func rejectsLinksWithoutThePairingSecret() {
        #expect(RemoteLink(string: "https://remote.example.com/remote/v4?sid=xd_1&t=1") == nil)
        #expect(RemoteLink(string: "https://remote.example.com/remote/v4?hash=a&t=1") == nil)
        #expect(RemoteLink(string: "not a link") == nil)
    }

    @Test func allowsPlainHttpOnlyOnTheLocalNetwork() {
        let query = "?sid=s&hash=h&t=1"
        #expect(RemoteLink(string: "http://localhost:5173/remote\(query)") != nil)
        #expect(RemoteLink(string: "http://192.168.1.20:5173/remote\(query)") != nil)
        #expect(RemoteLink(string: "http://172.20.0.5/remote\(query)") != nil)
        #expect(RemoteLink(string: "http://studio.local:5173/remote\(query)") != nil)
        #expect(RemoteLink(string: "http://100.101.102.103:47120/remote\(query)") != nil)
        #expect(RemoteLink(string: "http://remote.example.com/remote\(query)") == nil)
        #expect(RemoteLink(string: "http://172.32.0.5/remote\(query)") == nil)
        #expect(RemoteLink(string: "ftp://localhost/remote\(query)") == nil)
    }

    @Test func readsTheMacsCertificateFingerprint() throws {
        let fingerprint = String(repeating: "ab", count: 32)
        let link = try #require(RemoteLink(string: "https://192.168.1.20:47120/remote?fp=\(fingerprint.uppercased())&sid=s&hash=h&t=1"))
        #expect(link.certificateFingerprint == fingerprint)
        let malformed = try #require(RemoteLink(string: "https://192.168.1.20:47120/remote?fp=zz&sid=s&hash=h&t=1"))
        #expect(malformed.certificateFingerprint == nil)
    }

    @Test func opensAppLinks() throws {
        let encoded = try #require(pairing.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        let link = try #require(RemoteLink(appURL: URL(string: "xatlas://remote?link=\(encoded)")!))
        #expect(link.url.absoluteString == pairing)
        #expect(RemoteLink(appURL: URL(string: "xatlas://other?link=\(encoded)")!) == nil)
    }

    @Test func keepsNavigationOnTheRemotesOrigin() throws {
        let link = try #require(RemoteLink(string: pairing))
        #expect(link.isSameOrigin(URL(string: "https://remote.example.com/remote/v4/assets/app.js")!))
        #expect(!link.isSameOrigin(URL(string: "https://example.org/")!))
        #expect(!link.isSameOrigin(URL(string: "https://remote.example.com:8443/")!))
    }
}
