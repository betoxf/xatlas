import SwiftUI
import CoreImage.CIFilterBuiltins

enum SettingsSection: String, CaseIterable, Identifiable {
    case general
    case aiSync
    case remoteAccess
    case about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return "General"
        case .aiSync: return "AI Sync"
        case .remoteAccess: return "Remote Access"
        case .about: return "About"
        }
    }

    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .aiSync: return "sparkles"
        case .remoteAccess: return "antenna.radiowaves.left.and.right"
        case .about: return "info.circle"
        }
    }
}

struct AppSettingsView: View {
    @Bindable var state: AppState
    @State private var preferences = AppPreferences.shared
    @State private var updateService = AppUpdateService.shared
    @State private var selectedSection: SettingsSection = .general

    var body: some View {
        HStack(spacing: 0) {
            // Settings sidebar

            VStack(alignment: .leading, spacing: 0) {
                Spacer().frame(height: 12)

                Button {
                    state.isSettingsPresented = false
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.left")
                            .font(.system(size: 11, weight: .semibold))
                        Text("Back to app")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .padding(.bottom, 12)

                VStack(spacing: 2) {
                    ForEach(SettingsSection.allCases) { section in
                        Button {
                            selectedSection = section
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: section.icon)
                                    .font(.system(size: 12))
                                    .foregroundStyle(selectedSection == section ? .white : .secondary)
                                    .frame(width: 18, alignment: .center)
                                Text(section.title)
                                    .font(.system(size: 13, weight: selectedSection == section ? .medium : .regular))
                                    .foregroundStyle(selectedSection == section ? .white : .primary)
                                Spacer()
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(selectedSection == section ? Color.accentColor : Color.clear)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 10)

                Spacer()
            }
            .frame(width: 200)
            .background(.white.opacity(0.5))

            Divider()

            // Settings content
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(selectedSection.title)
                        .font(.system(size: 22, weight: .semibold))
                        .padding(.bottom, 20)

                    switch selectedSection {
                    case .general:
                        generalContent
                    case .aiSync:
                        aiSyncContent
                    case .remoteAccess:
                        remoteAccessContent
                    case .about:
                        aboutContent
                    }
                }
                .padding(28)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .onExitCommand {
            state.isSettingsPresented = false
        }
        .onAppear {
            if preferences.remoteAccessEnabled {
                RemoteAccessBridgeManager.shared.startIfNeeded()
            }
        }
    }

    // MARK: - General

    private var generalContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsCard {
                SettingsRow(title: "Launch mode", subtitle: "How xatlas starts up") {
                    Text("Normal")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }

                Divider()

                SettingsRow(title: "Default view", subtitle: "Which view to show on launch") {
                    Picker("", selection: Binding(
                        get: { preferences.defaultViewIsDashboard },
                        set: { preferences.defaultViewIsDashboard = $0 }
                    )) {
                        Text("Dashboard").tag(true)
                        Text("Workspace").tag(false)
                    }
                    .labelsHidden()
                    .frame(width: 130)
                }
            }

            SettingsCard {
                SettingsRow(title: "App update", subtitle: updateService.statusSummary) {
                    HStack(spacing: 10) {
                        if updateService.isBusy {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Button(updateService.actionTitle) {
                            updateService.performPrimaryAction(interactive: true)
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(updateService.isBusy ? Color.secondary : Color.accentColor)
                        .disabled(updateService.isBusy)
                    }
                }
            }
        }
    }

    // MARK: - AI Sync

    private var aiSyncContent: some View {
        SettingsCard {
            SettingsRow(title: "AI commit messages", subtitle: "Use AI to generate commit messages when syncing") {
                Toggle("", isOn: $preferences.useAIForSync)
                    .labelsHidden()
                    .toggleStyle(.switch)
            }

            Divider()

            SettingsRow(title: "Provider", subtitle: "Which AI provider to use") {
                Picker("", selection: $preferences.syncProvider) {
                    ForEach(AISyncProvider.allCases) { provider in
                        Text(provider.label).tag(provider)
                    }
                }
                .labelsHidden()
                .frame(width: 150)
                .disabled(!preferences.useAIForSync)
            }

            Divider()

            SettingsRow(title: "Push after sync", subtitle: "Automatically push after committing") {
                Toggle("", isOn: $preferences.pushAfterSync)
                    .labelsHidden()
                    .toggleStyle(.switch)
            }
        }
    }

    // MARK: - Remote Access

    @State private var relayPairingPayload: RelayPairingPayload? = nil
    @State private var bridgeStatus: BridgeStatus? = nil
    @State private var bridgeStatusTimer: Timer? = nil

    private var remoteAccessContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            SettingsCard {
                SettingsRow(title: "Enable iOS remote control", subtitle: "Allow paired iOS devices to control terminals") {
                    Toggle("", isOn: $preferences.remoteAccessEnabled)
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .onChange(of: preferences.remoteAccessEnabled) { _, enabled in
                            MCPServer.shared.restart()
                            if enabled {
                                StreamingServer.shared.start()
                                RemoteAccessBridgeManager.shared.startIfNeeded()
                                startBridgeStatusPolling()
                            } else {
                                RemoteAccessBridgeManager.shared.stop()
                                StreamingServer.shared.stop()
                                stopBridgeStatusPolling()
                            }
                        }
                }
            }

            if preferences.remoteAccessEnabled {
                // Bridge status card
                SettingsCard {
                    SettingsRow(
                        title: "Bridge Status",
                        subtitle: bridgeStatusSubtitle
                    ) {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(bridgeStatusColor)
                                .frame(width: 8, height: 8)
                            Text(bridgeStatusLabel)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // QR code card — relay QR from the managed bridge service
                SettingsCard {
                    VStack(spacing: 12) {
                        if let relayQR = relayPairingPayload, let qrImage = generateRelayQRCode(payload: relayQR) {
                            Text("Scan with xatlas iOS")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.secondary)

                            Image(nsImage: qrImage)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(width: 160, height: 160)
                                .background(Color.white)
                                .cornerRadius(8)

                            Text("Session: \(String(relayQR.sessionId.prefix(8)))...")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.tertiary)

                            if relayQR.expiresAt > 0 {
                                let expiry = Date(timeIntervalSince1970: TimeInterval(relayQR.expiresAt) / 1000)
                                Text("Expires: \(expiry.formatted(.relative(presentation: .named)))")
                                    .font(.system(size: 10))
                                    .foregroundStyle(.tertiary)
                            }
                        } else {
                            ProgressView()
                                .controlSize(.regular)
                            Text("Starting the local relay bridge for xatlas iOS")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.secondary)
                            Text("The QR will appear here as soon as the bridge publishes a pairing session.")
                                .font(.system(size: 10))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .frame(maxWidth: .infinity)
                }

                if let ip = MCPServer.lanIPAddress(), let port = MCPServer.shared.boundPort {
                    SettingsCard {
                        SettingsRow(title: "LAN Address", subtitle: "Connect from the same network") {
                            Text("\(ip):\(port)")
                                .font(.system(size: 12, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                }

            }
        }
        .animation(.easeInOut(duration: 0.2), value: preferences.remoteAccessEnabled)
        .onAppear {
            if preferences.remoteAccessEnabled {
                RemoteAccessBridgeManager.shared.startIfNeeded()
                startBridgeStatusPolling()
            }
        }
        .onDisappear {
            stopBridgeStatusPolling()
        }
    }

    // MARK: - About

    private var aboutContent: some View {
        SettingsCard {
            SettingsRow(title: "xatlas", subtitle: "Terminal multiplexer with AI orchestration") {
                Text("v\(updateService.currentVersion)")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - QR Code Generation

    /// Generates a relay-format QR code from the bridge's pairing payload.
    private func generateRelayQRCode(payload: RelayPairingPayload) -> NSImage? {
        let dict: [String: Any] = [
            "v": payload.v,
            "relay": payload.relay,
            "sessionId": payload.sessionId,
            "macDeviceId": payload.macDeviceId,
            "macIdentityPublicKey": payload.macIdentityPublicKey,
            "expiresAt": payload.expiresAt
        ]
        return generateQRImage(from: dict)
    }

    private func generateQRImage(from dict: [String: Any]) -> NSImage? {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: dict),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return nil }

        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(jsonString.utf8)
        filter.correctionLevel = "M"

        guard let ciImage = filter.outputImage else { return nil }

        let scale = 10.0
        let scaled = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }

    // MARK: - Bridge Status Polling

    /// Reads the relay pairing session written by xatlas-bridge to ~/.xatlas/pairing-session.json
    private func loadRelayPairingPayload() {
        let stateDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".xatlas", isDirectory: true)
        let pairingFile = stateDir.appendingPathComponent("pairing-session.json")

        guard let data = try? Data(contentsOf: pairingFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let nested = json["pairingPayload"] as? [String: Any] else {
            relayPairingPayload = nil
            return
        }

        relayPairingPayload = RelayPairingPayload(
            v: nested["v"] as? Int ?? 2,
            relay: nested["relay"] as? String ?? "",
            sessionId: nested["sessionId"] as? String ?? "",
            macDeviceId: nested["macDeviceId"] as? String ?? "",
            macIdentityPublicKey: nested["macIdentityPublicKey"] as? String ?? "",
            expiresAt: nested["expiresAt"] as? Int64 ?? 0
        )
    }

    /// Reads bridge status from ~/.xatlas/bridge-status.json
    private func loadBridgeStatus() {
        let stateDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".xatlas", isDirectory: true)
        let statusFile = stateDir.appendingPathComponent("bridge-status.json")

        guard let data = try? Data(contentsOf: statusFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            bridgeStatus = nil
            return
        }

        bridgeStatus = BridgeStatus(
            state: json["state"] as? String ?? "unknown",
            connectionStatus: json["connectionStatus"] as? String ?? "unknown",
            lastError: json["lastError"] as? String
        )
    }

    private func startBridgeStatusPolling() {
        loadRelayPairingPayload()
        loadBridgeStatus()
        bridgeStatusTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            Task { @MainActor in
                loadRelayPairingPayload()
                loadBridgeStatus()
            }
        }
    }

    private func stopBridgeStatusPolling() {
        bridgeStatusTimer?.invalidate()
        bridgeStatusTimer = nil
    }

    private var bridgeStatusLabel: String {
        guard let status = bridgeStatus else { return "Not running" }
        switch status.state {
        case "connected": return "Connected"
        case "connecting": return "Connecting..."
        case "error": return "Error"
        default: return status.state.capitalized
        }
    }

    private var bridgeStatusSubtitle: String {
        if bridgeStatus == nil {
            return "xatlas is starting the local relay bridge for secure iPhone pairing."
        }
        if let error = bridgeStatus?.lastError {
            return error
        }
        return "Relay bridge is active"
    }

    private var bridgeStatusColor: Color {
        guard let status = bridgeStatus else { return .gray }
        switch status.state {
        case "connected": return .green
        case "connecting": return .orange
        case "error": return .red
        default: return .gray
        }
    }
}

// MARK: - Reusable settings components

private struct SettingsCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.white.opacity(0.6))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(.white.opacity(0.3), lineWidth: 1)
        )
    }
}

private struct SettingsRow<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                Text(subtitle)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            trailing
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Relay Models

/// Matches the QR payload format produced by xatlas-bridge (CodexPairingQRPayload v2)
struct RelayPairingPayload {
    let v: Int           // protocol version (must be 2)
    let relay: String    // WebSocket relay base URL
    let sessionId: String
    let macDeviceId: String
    let macIdentityPublicKey: String  // Ed25519 public key, base64
    let expiresAt: Int64              // epoch ms
}

struct BridgeStatus {
    let state: String            // "connected", "connecting", "error", etc.
    let connectionStatus: String
    let lastError: String?
}
