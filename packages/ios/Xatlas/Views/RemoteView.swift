import CryptoKit
import SwiftUI
import WebKit

/// The Mac's phone remote, loaded from the pairing link. The page runs the
/// connection itself; this view adds a slim bar in the page's own color, loading and
/// failure states, and the way to pair again.
struct RemoteView: View {
    let link: RemoteLink

    @Environment(AppModel.self) private var model
    @State private var phase = RemoteWebView.Phase.loading
    @State private var pageColor: UIColor?
    @State private var reloadToken = 0
    @State private var confirmForget = false
    @State private var isScanning = false

    private var chromeColor: Color {
        pageColor.map(Color.init(uiColor:)) ?? RemoteWebView.pageBackground
    }

    var body: some View {
        VStack(spacing: 0) {
            bar
            ZStack {
                RemoteWebView(link: link, reloadToken: reloadToken, phase: $phase, pageColor: $pageColor)
                    .ignoresSafeArea(edges: .bottom)
                    .opacity(phase == .loaded ? 1 : 0)

                switch phase {
                case .loading:
                    VStack(spacing: 14) {
                        ProgressView()
                        Text(link.displayName.map { "Connecting to \($0)…" } ?? "Connecting to your Mac…")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                case .failed(let message):
                    failure(message)
                case .loaded:
                    EmptyView()
                }
            }
        }
        .background(chromeColor.ignoresSafeArea())
        .preferredColorScheme(pageColor?.isDark ?? true ? .dark : .light)
        .animation(.easeOut(duration: 0.2), value: phase)
        .fullScreenCover(isPresented: $isScanning) {
            ScannerScreen { newLink in
                isScanning = false
                model.pair(with: newLink)
            }
        }
        .confirmationDialog("Forget this Mac?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { model.forget() }
        } message: {
            Text("You'll need to scan its pairing code again to reconnect.")
        }
    }

    private var bar: some View {
        HStack(spacing: 10) {
            Image("XatlasMark")
                .resizable()
                .frame(width: 22, height: 22)
                .accessibilityHidden(true)
            Text(link.displayName ?? "Your Mac")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Menu {
                Button("Reload", systemImage: "arrow.clockwise") { reload() }
                Button("Pair another Mac", systemImage: "qrcode.viewfinder") { isScanning = true }
                Button("Forget this Mac", systemImage: "xmark.circle", role: .destructive) {
                    confirmForget = true
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .frame(width: 40, height: 36)
                    .contentShape(.rect)
            }
            .accessibilityLabel("More")
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .frame(height: 40)
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text("Couldn't open the remote").font(.title3.weight(.semibold))
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 12) {
                Button("Try again") { reload() }
                    .buttonStyle(.borderedProminent)
                Button("Pair again") { isScanning = true }
                    .buttonStyle(.bordered)
            }
            .buttonBorderShape(.capsule)
            .padding(.top, 6)
        }
        .padding(32)
        .frame(maxWidth: 420)
    }

    private func reload() {
        phase = .loading
        reloadToken += 1
    }
}

/// WKWebView that keeps navigation on the remote's origin, sends other links to Safari,
/// and reports the page's `theme-color` so the native chrome can match it.
struct RemoteWebView: UIViewRepresentable {
    enum Phase: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    /// The remote page's default dark background, shown until it reports its own color.
    static let pageBackground = Color(red: 0x16 / 255, green: 0x16 / 255, blue: 0x16 / 255)

    let link: RemoteLink
    let reloadToken: Int
    @Binding var phase: Phase
    @Binding var pageColor: UIColor?

    func makeCoordinator() -> Coordinator {
        Coordinator(link: link, phase: $phase, pageColor: $pageColor)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.applicationNameForUserAgent = "xatlasiOS/\(Bundle.main.shortVersion)"
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        #if DEBUG
        webView.isInspectable = true
        #endif
        context.coordinator.observeThemeColor(of: webView)
        context.coordinator.loadedToken = reloadToken
        webView.load(URLRequest(url: link.url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedToken != reloadToken else { return }
        context.coordinator.loadedToken = reloadToken
        if webView.url == nil {
            webView.load(URLRequest(url: link.url))
        } else {
            webView.reload()
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let link: RemoteLink
        let phase: Binding<Phase>
        let pageColor: Binding<UIColor?>
        var loadedToken = 0
        private var themeObservation: NSKeyValueObservation?

        init(link: RemoteLink, phase: Binding<Phase>, pageColor: Binding<UIColor?>) {
            self.link = link
            self.phase = phase
            self.pageColor = pageColor
        }

        func observeThemeColor(of webView: WKWebView) {
            themeObservation = webView.observe(\.themeColor, options: [.initial, .new]) { [weak self] webView, _ in
                MainActor.assumeIsolated {
                    let color = webView.themeColor
                    webView.underPageBackgroundColor = color
                    self?.pageColor.wrappedValue = color
                }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" || link.isSameOrigin(url) {
                return .allow
            }
            if navigationAction.targetFrame?.isMainFrame ?? true {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            phase.wrappedValue = .loaded
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            fail(error)
        }

        /// A Mac serving the remote itself uses a self-signed certificate; trust exactly the
        /// one whose fingerprint came with the pairing link, and only for that address.
        func webView(
            _ webView: WKWebView,
            respondTo challenge: URLAuthenticationChallenge
        ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
            let space = challenge.protectionSpace
            guard
                space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                let pinned = link.certificateFingerprint,
                space.host.lowercased() == link.url.host?.lowercased(),
                let trust = space.serverTrust
            else { return (.performDefaultHandling, nil) }
            guard
                let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
                Self.fingerprint(of: leaf) == pinned
            else { return (.cancelAuthenticationChallenge, nil) }
            return (.useCredential, URLCredential(trust: trust))
        }

        private static func fingerprint(of certificate: SecCertificate) -> String {
            SHA256.hash(data: SecCertificateCopyData(certificate) as Data)
                .map { String(format: "%02x", $0) }
                .joined()
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        /// `window.open` and `target=_blank` links open in Safari.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url { UIApplication.shared.open(url) }
            return nil
        }

        private func fail(_ error: any Error) {
            let nsError = error as NSError
            // A navigation replaced by another one isn't a failure.
            if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
            phase.wrappedValue = .failed(nsError.localizedDescription)
        }
    }
}

private extension UIColor {
    var isDark: Bool {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return true }
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.5
    }
}

private extension Bundle {
    var shortVersion: String {
        object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}
