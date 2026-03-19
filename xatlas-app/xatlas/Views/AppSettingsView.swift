import SwiftUI

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
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Pairing Code")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.secondary)

                            HStack(spacing: 4) {
                                Text(pairingCode)
                                    .font(.system(size: 28, weight: .bold, design: .monospaced))
                                    .tracking(6)
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

                        Text("Open the xatlas iOS app and enter this code to pair your device for remote terminal access.")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .formStyle(.grouped)
            .padding(.horizontal, 8)
        }
        .frame(width: 440, height: preferences.remoteAccessEnabled ? 520 : 280)
        .background(Color(nsColor: .windowBackgroundColor))
        .animation(.easeInOut(duration: 0.2), value: preferences.remoteAccessEnabled)
        .onExitCommand {
            dismiss()
        }
    }
}
