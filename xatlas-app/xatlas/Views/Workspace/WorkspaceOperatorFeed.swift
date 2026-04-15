import SwiftUI

/// Three-pill summary at the top of the operator feed showing live
/// counts of running / attention-needed / project-spanning sessions.
struct OperatorSummaryRow: View {
    let runningCount: Int
    let attentionCount: Int
    let projectCount: Int

    var body: some View {
        HStack(spacing: 8) {
            ScopeBadge(text: "\(runningCount) running")
            ScopeBadge(text: "\(attentionCount) attention")
            ScopeBadge(text: "\(projectCount) projects")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row in the operator event feed. Renders a status dot + heading
/// pills + the command, plus quick-action buttons (open / retry / clear).
struct OperatorEventRow: View {
    let event: OperatorEvent
    let projectName: String?
    @Bindable var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Circle()
                    .fill(tint)
                    .frame(width: 9, height: 9)
                    .padding(.top, 5)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(.system(size: 13, weight: .semibold))
                        ScopeBadge(text: projectName ?? "Global")
                        ScopeBadge(text: event.sessionTitle)
                        Text(relativeTime)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }

                    Text(event.command)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(.primary.opacity(0.82))
                        .lineLimit(2)

                    if let details = event.details, !details.isEmpty {
                        Text(details)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }

                Spacer()
            }

            HStack(spacing: 8) {
                Button("Open Terminal") {
                    _ = state.openTerminalSession(event.sessionID)
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(.white.opacity(0.36)))

                Button("Retry") {
                    _ = state.retryLastCommand(for: event.sessionID)
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(.white.opacity(0.36)))

                Button("Clear Attention") {
                    _ = state.clearAttention(for: event.sessionID)
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(.white.opacity(0.36)))
            }
        }
        .padding(14)
        .xatlasSectionSurface()
    }

    private var title: String {
        switch event.kind {
        case .commandStarted: return "Started"
        case .commandFinished: return "Finished"
        case .commandFailed: return "Failed"
        }
    }

    private var tint: Color {
        switch event.kind {
        case .commandStarted: return .blue.opacity(0.75)
        case .commandFinished: return .green.opacity(0.78)
        case .commandFailed: return .red.opacity(0.8)
        }
    }

    private var relativeTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: event.timestamp, relativeTo: .now)
    }
}
