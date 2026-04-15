import SwiftUI

/// Small uppercase pill used for inline metadata (provider, scope,
/// transport, category). Rendered inside catalog rows.
struct ScopeBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .foregroundStyle(.primary.opacity(0.65))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: XatlasLayout.compactCornerRadius, style: .continuous)
                    .fill(.white.opacity(0.5))
            )
    }
}

/// Bottom-of-card monospaced label that displays the source file path
/// of a catalog entry, with `~` substitution for the home directory.
struct SourcePathLabel: View {
    let path: String

    var body: some View {
        Text(path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(.primary.opacity(0.4))
            .lineLimit(1)
    }
}
