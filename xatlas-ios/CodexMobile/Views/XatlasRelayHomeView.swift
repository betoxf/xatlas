// FILE: XatlasRelayHomeView.swift
// Purpose: Remote workspace browser for xatlas relay connections.
// Layer: View
// Exports: XatlasRelayHomeView
// Depends on: SwiftUI, CodexService, XatlasRelayService

import SwiftUI

struct XatlasRelayHomeView: View {
    @Environment(CodexService.self) private var codex
    @State private var relay = XatlasRelayService()
    @State private var selectedSession: XatlasSession?
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Group {
                switch relay.connectionState {
                case .disconnected, .loading:
                    ProgressView("Loading xatlas workspace...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .error(let message):
                    ContentUnavailableView(
                        "xatlas Relay Unavailable",
                        systemImage: "wifi.exclamationmark",
                        description: Text(message)
                    )
                case .connected:
                    workspaceList
                }
            }
            .navigationTitle("xatlas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showScanner = true
                    } label: {
                        Image(systemName: "qrcode.viewfinder")
                    }
                }

                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        Task { await relay.refreshWorkspaceState(codex: codex) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }

                    Button("Disconnect") {
                        Task { await codex.disconnect() }
                    }
                }
            }
        }
        .task(id: codex.isConnected && codex.isXatlasRuntime) {
            await relay.activate(codex: codex)
        }
        .onDisappear {
            relay.deactivate()
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView(
                onBack: { showScanner = false },
                onScan: { payload in
                    showScanner = false
                    Task {
                        await ContentViewModel().connectToRelay(pairingPayload: payload, codex: codex)
                    }
                }
            )
        }
        .sheet(item: $selectedSession) { session in
            XatlasRelayTerminalSheet(session: session, relay: relay)
                .environment(codex)
        }
    }

    private var workspaceList: some View {
        List {
            Section {
                LabeledContent("Connection", value: "Relay")
                LabeledContent("Mode", value: relay.projectSurface.capitalized)
                if !relay.selectedSessionId.isEmpty {
                    LabeledContent("Selected Terminal", value: relay.selectedSessionId)
                        .font(.caption.monospaced())
                }
            }

            ForEach(relay.projects) { project in
                Section {
                    ForEach(relay.sessionsForProject(project.id)) { session in
                        Button {
                            Task {
                                await relay.selectProject(codex: codex, projectId: project.id)
                                await relay.selectSession(codex: codex, sessionId: session.id)
                            }
                            selectedSession = session
                        } label: {
                            XatlasRelaySessionRow(
                                session: session,
                                isSelected: session.id == relay.selectedSessionId
                            )
                        }
                        .buttonStyle(.plain)
                    }

                    if relay.sessionsForProject(project.id).isEmpty {
                        Text("No active terminals")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name)
                        Text(project.path)
                            .font(.caption.monospaced())
                            .textCase(nil)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            let ungrouped = relay.sessions.filter { $0.projectId.isEmpty }
            if !ungrouped.isEmpty {
                Section("Other Terminals") {
                    ForEach(ungrouped) { session in
                        Button {
                            Task {
                                await relay.selectSession(codex: codex, sessionId: session.id)
                            }
                            selectedSession = session
                        } label: {
                            XatlasRelaySessionRow(
                                session: session,
                                isSelected: session.id == relay.selectedSessionId
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await relay.refreshWorkspaceState(codex: codex)
        }
    }
}

private struct XatlasRelaySessionRow: View {
    let session: XatlasSession
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(session.attention ? .orange : (session.state == "idle" ? .green : .blue))
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .foregroundStyle(.primary)
                if !session.lastCommand.isEmpty {
                    Text("$ \(session.lastCommand)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if isSelected {
                Text("Selected")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.blue)
            } else {
                Text(session.state.capitalized)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(session.state == "idle" ? .green : .blue)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct XatlasRelayTerminalSheet: View {
    let session: XatlasSession
    let relay: XatlasRelayService

    @Environment(CodexService.self) private var codex
    @Environment(\.dismiss) private var dismiss
    @State private var terminalOutput = ""
    @State private var commandText = ""
    @State private var isLoading = true
    @State private var refreshTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    Group {
                        if isLoading {
                            ProgressView("Loading terminal...")
                                .frame(maxWidth: .infinity, minHeight: 160)
                        } else {
                            Text(terminalOutput.isEmpty ? "No terminal output yet." : terminalOutput)
                                .font(.system(size: 11, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .textSelection(.enabled)
                        }
                    }
                }

                Divider()

                HStack(spacing: 8) {
                    Text("$")
                        .font(.system(.subheadline, design: .monospaced))
                        .foregroundStyle(.secondary)

                    TextField("Command...", text: $commandText)
                        .font(.system(.subheadline, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit {
                            sendCommand()
                        }

                    Button {
                        sendCommand()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .disabled(commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding()
            }
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") {
                        dismiss()
                    }
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
        .presentationDetents([.medium, .large])
        .task {
            await loadSnapshot()
            startAutoRefresh()
        }
        .onDisappear {
            refreshTask?.cancel()
            refreshTask = nil
        }
    }

    private func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled else { return }
                await loadSnapshot()
            }
        }
    }

    private func loadSnapshot() async {
        isLoading = true
        terminalOutput = await relay.fetchSnapshot(codex: codex, sessionId: session.id) ?? terminalOutput
        isLoading = false
    }

    private func sendCommand() {
        let command = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            return
        }

        commandText = ""
        Task {
            _ = await relay.sendCommand(codex: codex, sessionId: session.id, command: command)
            try? await Task.sleep(nanoseconds: 400_000_000)
            await loadSnapshot()
            await relay.refreshWorkspaceState(codex: codex)
        }
    }
}
