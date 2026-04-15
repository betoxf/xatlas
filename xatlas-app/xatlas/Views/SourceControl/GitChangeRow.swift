import SwiftUI

/// One row in the source-control changed-files list. Status letter +
/// file icon + short filename, with a subtle hover fill.
struct GitChangeRow: View {
    let change: GitChange
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 6) {
            Text(change.status.label)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(statusColor)
                .frame(width: 14)

            Image(systemName: fileIcon)
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .frame(width: 14)

            Text(shortName)
                .font(.system(size: 12))
                .foregroundStyle(.primary.opacity(0.75))
                .lineLimit(1)

            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color.primary.opacity(isHovered ? 0.04 : 0))
        )
        .onHover { isHovered = $0 }
    }

    private var statusColor: Color {
        switch change.status {
        case .modified: return .orange.opacity(0.8)
        case .added: return .green.opacity(0.7)
        case .deleted: return .red.opacity(0.7)
        case .untracked: return .gray.opacity(0.6)
        case .renamed: return .blue.opacity(0.7)
        }
    }

    private var fileIcon: String {
        change.status == .deleted ? "minus.circle" : "doc.text"
    }

    private var shortName: String {
        URL(fileURLWithPath: change.file).lastPathComponent
    }
}
