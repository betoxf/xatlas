import SwiftUI

/// Dashed-border placeholder tile that lives at the end of the dashboard
/// grid and triggers the project picker.
struct AddProjectTile: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 12) {
                Image(systemName: "plus")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(.secondary.opacity(0.8))
                Text("Add Project")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 174, maxHeight: 174)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [7, 7]))
                    .foregroundStyle(.secondary.opacity(isHovered ? 0.45 : 0.25))
            )
        }
        .buttonStyle(.plain)
        .scaleEffect(isHovered ? 1.012 : 1.0)
        .offset(y: isHovered ? -1 : 0)
        .animation(XatlasMotion.hover, value: isHovered)
        .xatlasPressEffect()
        .onHover { isHovered = $0 }
    }
}
