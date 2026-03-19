import SwiftUI

struct DashboardView: View {
    @Environment(AppConnectionState.self) private var appState
    @State private var pollingTask: Task<Void, Never>?
    @State private var selectedSession: RemoteSessionInfo?

    var body: some View {
        NavigationStack {
            List {
                if appState.workspaceState.projects.isEmpty && appState.workspaceState.sessions.isEmpty {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Connecting to desktop...")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 8)
                    }
                }

                if !appState.workspaceState.projects.isEmpty {
                    Section("Projects") {
                        ForEach(appState.workspaceState.projects) { project in
                            ProjectCardView(
                                project: project,
                                sessions: appState.workspaceState.sessions.filter { $0.projectId == project.id.uuidString },
                                isSelected: appState.workspaceState.selectedProjectId == project.id.uuidString
                            )
                        }
                    }
                }

                if !appState.workspaceState.sessions.isEmpty {
                    Section("Terminal Sessions") {
                        ForEach(appState.workspaceState.sessions) { session in
                            SessionRowView(session: session)
                                .onTapGesture {
                                    selectedSession = session
                                }
                        }
                    }
                }

                if !appState.workspaceState.operatorEvents.isEmpty {
                    Section("Recent Activity") {
                        ForEach(appState.workspaceState.operatorEvents) { event in
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(eventColor(event.kind))
                                    .frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(event.command)
                                        .font(.system(.caption, design: .monospaced))
                                        .lineLimit(1)
                                    if let details = event.details, !details.isEmpty {
                                        Text(details)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("xatlas")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        appState.disconnect()
                    } label: {
                        Image(systemName: "xmark.circle")
                    }
                }
            }
            .fullScreenCover(item: $selectedSession) { session in
                TerminalContainerView(session: session)
            }
            .onAppear { startPolling() }
            .onDisappear { stopPolling() }
        }
    }

    private func startPolling() {
        guard let info = appState.connectionInfo else { return }
        let service = ConnectionService(host: info.host, port: info.port, token: info.token)

        pollingTask = Task {
            while !Task.isCancelled {
                do {
                    let state = try await service.fetchState()
                    await MainActor.run {
                        appState.workspaceState = state
                    }
                } catch is ConnectionError {
                    await MainActor.run { appState.disconnect() }
                    return
                } catch {
                    // Network glitch, keep trying
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    private func eventColor(_ kind: String) -> Color {
        switch kind {
        case "commandStarted": .blue
        case "commandFinished": .green
        case "commandFailed": .red
        default: .gray
        }
    }
}
