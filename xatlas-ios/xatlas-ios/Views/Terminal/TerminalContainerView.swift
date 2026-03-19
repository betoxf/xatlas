import SwiftUI

struct TerminalContainerView: View {
    @Environment(AppConnectionState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    let session: RemoteSessionInfo
    @State private var streamService = TerminalStreamService()
    @State private var isConnecting = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Header bar
                HStack(spacing: 8) {
                    Circle()
                        .fill(streamService.isConnected ? .green : .orange)
                        .frame(width: 8, height: 8)

                    Text(session.title)
                        .font(.system(.subheadline, design: .monospaced, weight: .semibold))
                        .lineLimit(1)

                    Spacer()

                    Text(session.activityState.label)
                        .font(.caption2.bold())
                        .foregroundStyle(stateColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(stateColor.opacity(0.15)))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial)

                // Terminal
                RemoteTerminalView(streamService: streamService)
            }
            .background(.black)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        streamService.disconnect()
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.white.opacity(0.7))
                    }
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            .onAppear { connectStream() }
            .onDisappear { streamService.disconnect() }
        }
    }

    private func connectStream() {
        guard let info = appState.connectionInfo else { return }
        streamService.connect(
            host: info.host,
            streamPort: info.streamPort,
            sessionId: session.id,
            token: info.token
        )
        isConnecting = false
    }

    private var stateColor: Color {
        switch session.activityState {
        case .idle: .green
        case .running: .blue
        case .detached: .orange
        case .exited: .gray
        case .error: .red
        }
    }
}
