import SwiftUI
import CoreImage.CIFilterBuiltins

struct AppSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var preferences = AppPreferences.shared
    @State private var pairingCode = PairingService.shared.pairingCode
    @State private var pairedDevices = PairingService.shared.pairedDevices

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Settings")
                        .font(.system(size: 18, weight: .semibold))
                    Text("Project sync, AI behavior, and remote access.")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button("Done") {
                    dismiss()
                }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.55)))
                .accessibilityLabel("Close settings")
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)

            Form {
                Section("AI Sync") {
                    Toggle("Use AI-generated commit messages", isOn: $preferences.useAIForSync)

                    Picker("Provider", selection: $preferences.syncProvider) {
                        ForEach(AISyncProvider.allCases) { provider in
                            Text(provider.label).tag(provider)
                        }
                    }
                    .disabled(!preferences.useAIForSync)

                    Toggle("Push after sync", isOn: $preferences.pushAfterSync)

                    Text("Project sync uses the selected AI to write the commit message, then commits and optionally pushes.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                Section("Remote Access") {
                    Toggle("Enable iOS remote control", isOn: $preferences.remoteAccessEnabled)
                        .onChange(of: preferences.remoteAccessEnabled) { _, enabled in
                            MCPServer.shared.restart()
                            if enabled {
                                StreamingServer.shared.start()
                            } else {
                                StreamingServer.shared.stop()
                            }
                        }

                    if preferences.remoteAccessEnabled {
                        // QR Code — scan from iOS app to pair instantly
                        VStack(spacing: 10) {
                            if let qrImage = generateQRCode() {
                                Text("Scan with xatlas iOS")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(.secondary)

                                Image(nsImage: qrImage)
                                    .interpolation(.none)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(width: 180, height: 180)
                                    .background(Color.white)
                                    .cornerRadius(8)
                            }

                            HStack(spacing: 4) {
                                Text("Code:")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                                Text(pairingCode)
                                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                                    .textSelection(.enabled)
                                Spacer()
                                Button("Regenerate") {
                                    PairingService.shared.regenerateCode()
                                    pairingCode = PairingService.shared.pairingCode
                                }
                                .font(.system(size: 11, weight: .medium))
                                .buttonStyle(.plain)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Capsule().fill(.secondary.opacity(0.15)))
                            }
                        }
                        .frame(maxWidth: .infinity)

                        if let ip = MCPServer.lanIPAddress(), let port = MCPServer.shared.boundPort {
                            HStack {
                                Text("LAN Address")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text("\(ip):\(port)")
                                    .font(.system(size: 12, design: .monospaced))
                                    .textSelection(.enabled)
                            }
                        }

                        if !pairedDevices.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Paired Devices")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(.secondary)

                                ForEach(pairedDevices) { device in
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(device.deviceName)
                                                .font(.system(size: 13, weight: .medium))
                                            Text("Paired \(device.pairedAt.formatted(.relative(presentation: .named)))")
                                                .font(.system(size: 11))
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Button("Revoke") {
                                            PairingService.shared.revoke(token: device.token)
                                            pairedDevices = PairingService.shared.pairedDevices
                                        }
                                        .font(.system(size: 11, weight: .medium))
                                        .buttonStyle(.plain)
                                        .foregroundStyle(.red)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .padding(.horizontal, 8)
        }
        .frame(width: 440, height: preferences.remoteAccessEnabled ? 580 : 280)
        .background(Color(nsColor: .windowBackgroundColor))
        .animation(.easeInOut(duration: 0.2), value: preferences.remoteAccessEnabled)
        .onExitCommand {
            dismiss()
        }
    }

    // MARK: - QR Code Generation

    private func generateQRCode() -> NSImage? {
        guard let ip = MCPServer.lanIPAddress(),
              let port = MCPServer.shared.boundPort else { return nil }

        let streamPort = StreamingServer.shared.boundPort ?? 0
        let payload: [String: Any] = [
            "host": ip,
            "port": Int(port),
            "streamPort": Int(streamPort),
            "code": pairingCode
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return nil }

        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(jsonString.utf8)
        filter.correctionLevel = "M"

        guard let ciImage = filter.outputImage else { return nil }

        // Scale up for crisp rendering
        let scale = 10.0
        let scaled = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}
