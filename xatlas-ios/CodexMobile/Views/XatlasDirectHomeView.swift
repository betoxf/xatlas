// XatlasDirectHomeView.swift
// Purpose: Home screen when connected directly to xatlas macOS app over LAN.
// Shows projects, terminal sessions, and allows terminal interaction.

import SwiftUI

struct XatlasDirectHomeView: View {
    @State private var direct = XatlasDirectService.shared
    @State private var selectedSessionId: String?
    @State private var terminalText: String = ""
    @State private var commandInput: String = ""
    @State private var showSettings = false
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Group {
                switch direct.connectionState {
                case .disconnected:
                    disconnectedView
                case .pairing:
                    statusView(title: "Pairing...", subtitle: "Connecting to Mac", color: .orange)
                case .connecting:
                    statusView(title: "Connecting...", subtitle: "\(direct.macHost):\(direct.mcpPort)", color: .orange)
                case .connected:
                    connectedView
                case .error(let message):
                    errorView(message: message)
                }
            }
            .navigationTitle("xatlas")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Scan QR Code") {
                            showScanner = true
                        }
                        Button("Refresh") {
                            Task { await direct.fetchWorkspaceState() }
                        }
                        if direct.isConfigured {
                            Button("Disconnect", role: .destructive) {
                                direct.disconnect()
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .sheet(isPresented: $showScanner) {
                QRScannerView(
                    onBack: { showScanner = false },
                    onScan: { _ in showScanner = false },
                    onLANScan: { payload in
                        showScanner = false
                        Task {
                            await direct.pairAndConnect(payload: payload)
                        }
                    }
                )
            }
        }
    }

    // MARK: - Disconnected

    private var disconnectedView: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Not Connected")
                .font(.title2.weight(.semibold))

            Text("Open xatlas on your Mac, go to Settings → Remote Access, and scan the QR code.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            Button {
                showScanner = true
            } label: {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 40)

            if direct.isConfigured {
                Button("Reconnect to \(direct.macHost)") {
                    Task { await direct.reconnect() }
                }
                .font(.subheadline)
                .foregroundStyle(.blue)
            }

            Spacer()
        }
    }

    // MARK: - Connected

    private var connectedView: some View {
        List {
            if !direct.projects.isEmpty {
                ForEach(direct.projects) { project in
                    Section {
                        let projectSessions = direct.sessionsForProject(project.id)
                        if projectSessions.isEmpty {
                            Text("No active terminals")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(projectSessions) { session in
                                sessionRow(session)
                            }
                        }
                    } header: {
                        HStack(spacing: 8) {
                            Image(systemName: "folder.fill")
                                .foregroundStyle(.blue)
                            Text(project.name)
                                .font(.headline)
                        }
                    } footer: {
                        Text(project.path)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            // Sessions without a project
            let orphanSessions = direct.sessions.filter { $0.projectId.isEmpty }
            if !orphanSessions.isEmpty {
                Section("Other Terminals") {
                    ForEach(orphanSessions) { session in
                        sessionRow(session)
                    }
                }
            }

            if direct.projects.isEmpty && direct.sessions.isEmpty {
                Section {
                    VStack(spacing: 12) {
                        Image(systemName: "terminal")
                            .font(.system(size: 32))
                            .foregroundStyle(.secondary)
                        Text("No projects or terminals yet")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text("Open a project in xatlas on your Mac")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                }
            }

            Section {
                HStack {
                    Circle()
                        .fill(.green)
                        .frame(width: 8, height: 8)
                    Text("Connected to \(direct.macHost)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await direct.fetchWorkspaceState()
        }
        .sheet(item: $selectedSessionId) { sessionId in
            if let session = direct.sessions.first(where: { $0.id == sessionId }) {
                TerminalSessionView(session: session)
            }
        }
    }

    private func sessionRow(_ session: XatlasSession) -> some View {
        Button {
            selectedSessionId = session.id
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "terminal")
                    .font(.system(size: 14))
                    .foregroundStyle(session.attention ? .orange : .green)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)

                    if !session.lastCommand.isEmpty {
                        Text("$ \(session.lastCommand)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                Text(session.state)
                    .font(.caption2)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(session.state == "idle" ? Color.green.opacity(0.15) : Color.orange.opacity(0.15))
                    )
                    .foregroundStyle(session.state == "idle" ? .green : .orange)
            }
        }
        .tint(.primary)
    }

    // MARK: - Status Views

    private func statusView(title: String, subtitle: String, color: Color) -> some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
                .scaleEffect(1.2)
            Text(title)
                .font(.title3.weight(.semibold))
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }

    private func errorView(message: String) -> some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40))
                .foregroundStyle(.orange)

            Text("Connection Error")
                .font(.title3.weight(.semibold))

            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            HStack(spacing: 16) {
                Button("Scan QR") {
                    showScanner = true
                }
                .buttonStyle(.borderedProminent)

                Button("Retry") {
                    Task { await direct.reconnect() }
                }
                .buttonStyle(.bordered)
            }
            Spacer()
        }
    }
}

// MARK: - Terminal Session View

struct TerminalSessionView: View {
    let session: XatlasSession
    @State private var terminalOutput: String = "Loading..."
    @State private var commandText: String = ""
    @Environment(\.dismiss) private var dismiss
    private let direct = XatlasDirectService.shared

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Terminal output
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(terminalOutput)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.green)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .id("bottom")
                    }
                    .background(Color.black)
                    .onChange(of: terminalOutput) { _, _ in
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }

                Divider()

                // Command input
                HStack(spacing: 8) {
                    Text("$")
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundStyle(.secondary)

                    TextField("Command...", text: $commandText)
                        .font(.system(size: 14, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit {
                            sendCommand()
                        }

                    Button {
                        sendCommand()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 24))
                    }
                    .disabled(commandText.isEmpty)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.bar)
            }
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await loadSnapshot() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
        .task {
            await loadSnapshot()
            // Start streaming
            direct.connectTerminalStream(sessionId: session.id) { data in
                if let text = String(data: data, encoding: .utf8) {
                    Task { @MainActor in
                        terminalOutput += text
                    }
                }
            }
        }
        .onDisappear {
            direct.disconnectTerminalStream()
        }
    }

    private func loadSnapshot() async {
        if let snapshot = await direct.fetchSnapshot(sessionId: session.id) {
            terminalOutput = snapshot
        }
    }

    private func sendCommand() {
        let cmd = commandText
        commandText = ""
        Task {
            _ = await direct.sendCommand(sessionId: session.id, command: cmd)
            try? await Task.sleep(nanoseconds: 500_000_000)
            await loadSnapshot()
        }
    }
}

// Make String identifiable for sheet presentation
extension String: @retroactive Identifiable {
    public var id: String { self }
}
