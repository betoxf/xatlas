import SwiftUI

struct DiscoveryView: View {
    @Environment(AppConnectionState.self) private var appState
    @State private var discovery = DiscoveryService()
    @State private var manualHost = ""
    @State private var manualPort = "9012"
    @State private var showManualEntry = false

    var body: some View {
        NavigationStack {
            List {
                if discovery.discoveredHosts.isEmpty && discovery.isSearching {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Searching for xatlas on your network...")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 8)
                    }
                }

                if !discovery.discoveredHosts.isEmpty {
                    Section("Found Desktops") {
                        ForEach(discovery.discoveredHosts) { host in
                            Button {
                                appState.phase = .pairing(host)
                            } label: {
                                HStack {
                                    Image(systemName: "desktopcomputer")
                                        .font(.title2)
                                        .foregroundStyle(.tint)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(host.name)
                                            .font(.headline)
                                        Text("Tap to pair")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(.vertical, 4)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Section {
                    Button {
                        showManualEntry.toggle()
                    } label: {
                        Label("Connect manually", systemImage: "network")
                    }

                    if showManualEntry {
                        TextField("IP Address", text: $manualHost)
                            .textContentType(.URL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)

                        TextField("Port", text: $manualPort)
                            .keyboardType(.numberPad)

                        Button("Connect") {
                            let host = DiscoveredHost(
                                id: "manual-\(manualHost)",
                                name: manualHost,
                                endpoint: .hostPort(host: .init(manualHost), port: .init(integerLiteral: UInt16(manualPort) ?? 9012))
                            )
                            appState.phase = .pairing(host)
                        }
                        .disabled(manualHost.isEmpty)
                    }
                }
            }
            .navigationTitle("xatlas")
            .onAppear { discovery.startBrowsing() }
            .onDisappear { discovery.stopBrowsing() }
        }
    }
}
