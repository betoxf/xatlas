import SwiftUI

struct ProjectCardView: View {
    let project: Project
    let sessions: [RemoteSessionInfo]
    let isSelected: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(project.name)
                        .font(.headline)
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }

                Text(project.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if !sessions.isEmpty {
                let attentionCount = sessions.filter(\.attention).count
                HStack(spacing: 4) {
                    Text("\(sessions.count)")
                        .font(.caption.bold())
                    Image(systemName: "terminal")
                        .font(.caption)
                }
                .foregroundStyle(attentionCount > 0 ? .orange : .secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
