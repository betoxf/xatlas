import SwiftUI

struct SessionRowView: View {
    let session: RemoteSessionInfo

    var body: some View {
        HStack(spacing: 12) {
            // Status indicator
            Circle()
                .fill(stateColor)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(session.title)
                        .font(.system(.body, design: .monospaced))
                        .lineLimit(1)

                    if session.attention {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }

                if let cmd = session.lastCommand, !cmd.isEmpty {
                    Text(cmd)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if !session.cwd.isEmpty {
                    Text(session.cwd.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer()

            Text(session.activityState.label)
                .font(.caption2.bold())
                .foregroundStyle(stateColor)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    Capsule().fill(stateColor.opacity(0.15))
                )

            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
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
