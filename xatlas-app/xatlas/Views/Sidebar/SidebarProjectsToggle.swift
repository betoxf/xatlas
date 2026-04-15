import SwiftUI

/// Compact button in the Projects section header that flips between the
/// dashboard grid view and the active workspace view.
struct SidebarProjectsToggle: View {
    let mode: ProjectSurfaceMode
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: mode == .workspace ? "sidebar.left" : "square.grid.2x2")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color.primary.opacity(0.92))
                .frame(width: XatlasLayout.compactControlSize, height: XatlasLayout.compactControlSize)
                .background(
                    RoundedRectangle(cornerRadius: XatlasLayout.compactCornerRadius, style: .continuous)
                        .fill(.white.opacity(0.5))
                        .overlay(
                            RoundedRectangle(cornerRadius: XatlasLayout.compactCornerRadius, style: .continuous)
                                .strokeBorder(.white.opacity(0.40), lineWidth: 0.6)
                        )
                )
        }
        .buttonStyle(.plain)
        .xatlasPressEffect()
    }
}
