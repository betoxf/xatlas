import SwiftUI

struct PairingView: View {
    @Environment(AppConnectionState.self) private var appState
    let host: DiscoveredHost

    @State private var code = ""
    @State private var isPairing = false
    @State private var errorMessage: String?
    @State private var resolvedIP: String?
    @State private var resolvedPort: UInt16?
    @State private var discovery = DiscoveryService()

    var body: some View {
        NavigationStack {
            VStack(spacing: 32) {
                Spacer()

                VStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 48))
                        .foregroundStyle(.tint)
                    Text(host.name)
                        .font(.title2.bold())
                    Text("Enter the pairing code shown in\nxatlas Settings on your Mac")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                // Code entry
                TextField("000000", text: $code)
                    .font(.system(size: 36, weight: .bold, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .keyboardType(.numberPad)
                    .frame(maxWidth: 240)
                    .padding()
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(.ultraThinMaterial)
                    )
                    .onChange(of: code) { _, newValue in
                        // Auto-strip non-digits, limit to 6
                        let filtered = String(newValue.filter(\.isNumber).prefix(6))
                        if filtered != newValue { code = filtered }
                    }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.callout)
                        .foregroundStyle(.red)
                }

                Button {
                    Task { await pair() }
                } label: {
                    if isPairing {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Pair")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(code.count != 6 || isPairing)
                .padding(.horizontal, 40)

                Spacer()
                Spacer()
            }
            .padding()
            .navigationTitle("Pair Device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back") {
                        appState.phase = .discovering
                    }
                }
            }
            .task { await resolveHost() }
        }
    }

    private func resolveHost() async {
        if let (ip, port) = await discovery.resolve(host) {
            resolvedIP = ip
            resolvedPort = port
        }
    }

    private func pair() async {
        guard let ip = resolvedIP, let port = resolvedPort else {
            errorMessage = "Could not resolve host address"
            return
        }

        isPairing = true
        errorMessage = nil

        do {
            let deviceName: String
            #if canImport(UIKit)
            deviceName = await UIDevice.current.name
            #else
            deviceName = "iOS Device"
            #endif

            let info = try await ConnectionService.pair(
                host: ip,
                port: Int(port),
                code: code,
                deviceName: deviceName
            )
            appState.connect(info: info)
        } catch let error as ConnectionError {
            errorMessage = error.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }

        isPairing = false
    }
}
