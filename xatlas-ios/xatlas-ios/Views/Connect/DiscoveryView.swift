import SwiftUI

struct DiscoveryView: View {
    @Environment(AppConnectionState.self) private var appState
    @State private var discovery = DiscoveryService()
    @State private var isPairing = false
    @State private var errorMessage: String?
    @State private var showManualEntry = false
    @State private var manualHost = ""
    @State private var manualPort = "9012"
    @State private var manualCode = ""

    var body: some View {
        NavigationStack {
            ZStack {
                // QR Scanner as the main view
                QRScannerView { payload in
                    Task { await pairWithPayload(payload) }
                }
                .ignoresSafeArea()

                // Overlay UI
                VStack {
                    Spacer()

                    VStack(spacing: 16) {
                        if isPairing {
                            ProgressView("Connecting...")
                                .padding()
                                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                        }

                        if let errorMessage {
                            Text(errorMessage)
                                .font(.callout.bold())
                                .foregroundStyle(.white)
                                .padding()
                                .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 12))
                        }

                        // Scan target frame
                        if !isPairing {
                            VStack(spacing: 8) {
                                Text("Scan QR code from xatlas Settings")
                                    .font(.headline)
                                    .foregroundStyle(.white)
                                Text("Enable Remote Access on your Mac to see the code")
                                    .font(.caption)
                                    .foregroundStyle(.white.opacity(0.7))
                            }
                            .padding()
                            .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    .padding(.bottom, 40)

                    // Bonjour discovered hosts
                    if !discovery.discoveredHosts.isEmpty {
                        VStack(spacing: 8) {
                            ForEach(discovery.discoveredHosts) { host in
                                Button {
                                    appState.phase = .pairing(host)
                                } label: {
                                    HStack {
                                        Image(systemName: "desktopcomputer")
                                        Text(host.name)
                                            .font(.subheadline.bold())
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption)
                                    }
                                    .foregroundStyle(.white)
                                    .padding()
                                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                                }
                            }
                        }
                        .padding(.horizontal)
                        .padding(.bottom, 12)
                    }

                    // Manual entry button
                    Button {
                        showManualEntry = true
                    } label: {
                        Label("Enter manually", systemImage: "keyboard")
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.8))
                            .padding(.vertical, 10)
                            .padding(.horizontal, 16)
                            .background(.ultraThinMaterial, in: Capsule())
                    }
                    .padding(.bottom, 30)
                }
            }
            .navigationTitle("xatlas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .onAppear { discovery.startBrowsing() }
            .onDisappear { discovery.stopBrowsing() }
            .sheet(isPresented: $showManualEntry) {
                ManualEntrySheet(
                    host: $manualHost,
                    port: $manualPort,
                    code: $manualCode,
                    onConnect: { host, port, code in
                        showManualEntry = false
                        let payload = QRPairingPayload(host: host, port: port, streamPort: 9020, code: code)
                        Task { await pairWithPayload(payload) }
                    }
                )
                .presentationDetents([.medium])
            }
        }
    }

    private func pairWithPayload(_ payload: QRPairingPayload) async {
        isPairing = true
        errorMessage = nil

        do {
            let deviceName = await UIDevice.current.name
            let info = try await ConnectionService.pair(
                host: payload.host,
                port: payload.port,
                code: payload.code,
                deviceName: deviceName
            )
            await MainActor.run {
                appState.connect(info: info)
            }
        } catch {
            errorMessage = error.localizedDescription
            // Reset after a delay so user can try again
            try? await Task.sleep(for: .seconds(3))
            errorMessage = nil
        }

        isPairing = false
    }
}

// MARK: - Manual entry sheet

struct ManualEntrySheet: View {
    @Binding var host: String
    @Binding var port: String
    @Binding var code: String
    let onConnect: (String, Int, String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("IP Address (e.g. 192.168.1.50)", text: $host)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(.numbersAndPunctuation)

                    TextField("Port", text: $port)
                        .keyboardType(.numberPad)
                }

                Section("Pairing Code") {
                    TextField("6-digit code", text: $code)
                        .keyboardType(.numberPad)
                        .font(.system(.title2, design: .monospaced))
                        .onChange(of: code) { _, newValue in
                            let filtered = String(newValue.filter(\.isNumber).prefix(6))
                            if filtered != newValue { code = filtered }
                        }
                }

                Section {
                    Button("Connect") {
                        onConnect(host, Int(port) ?? 9012, code)
                    }
                    .frame(maxWidth: .infinity)
                    .disabled(host.isEmpty || code.count != 6)
                }
            }
            .navigationTitle("Manual Connection")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
