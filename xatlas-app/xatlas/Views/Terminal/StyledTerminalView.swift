import AppKit
import SwiftUI

/// Styled wrapper around the native tmux terminal. Renders a header
/// (title + cwd + activity pill) above the terminal grid and listens
/// for session-change notifications to refresh the header.
struct StyledTerminalView: View {
    let sessionID: String
    @Bindable var appState: AppState
    var focusToken: Int = 0
    @State private var session: TerminalSession?

    var body: some View {
        Group {
            if let session {
                VStack(spacing: 0) {
                    header(for: session)
                    NativeTmuxTerminalView(sessionID: sessionID, focusToken: focusToken)
                        .id(sessionID)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
                .xatlasSectionSurface(
                    radius: XatlasLayout.sectionCornerRadius,
                    fill: .white.opacity(0.4),
                    stroke: .white.opacity(0.34)
                )
                .padding(XatlasLayout.contentInset)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "terminal")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("Terminal session unavailable")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear(perform: refreshSession)
        .onChange(of: sessionID) { _, _ in
            refreshSession()
        }
        .onReceive(NotificationCenter.default.publisher(for: .xatlasTerminalSessionDidChange)) { note in
            guard let changed = note.userInfo?["session"] as? TerminalSession,
                  changed.id == sessionID else { return }
            session = changed
        }
    }

    @ViewBuilder
    private func header(for session: TerminalSession) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.primary.opacity(0.3))

            VStack(alignment: .leading, spacing: 2) {
                Text(session.displayTitle)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary.opacity(0.72))
                    .lineLimit(1)

                Text(session.displayDirectory)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.38))
                    .lineLimit(1)
            }

            Spacer()

            Text(statusLabel(for: session))
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(statusColor(for: session))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    Capsule().fill(statusColor(for: session).opacity(0.12))
                )
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(XatlasSurface.divider)
                .frame(height: 1)
                .padding(.horizontal, 12)
        }
    }

    private func activityColor(for state: TerminalActivityState) -> SwiftUI.Color {
        switch state {
        case .idle: return .blue.opacity(0.8)
        case .running: return .green.opacity(0.8)
        case .detached: return .orange.opacity(0.8)
        case .exited: return .secondary
        case .error: return .red.opacity(0.8)
        }
    }

    private func statusColor(for session: TerminalSession) -> SwiftUI.Color {
        session.requiresAttention ? .red.opacity(0.82) : activityColor(for: session.activityState)
    }

    private func statusLabel(for session: TerminalSession) -> String {
        session.requiresAttention ? "1" : session.activityState.label
    }

    private func refreshSession() {
        session = TerminalService.shared.session(id: sessionID)
    }
}
