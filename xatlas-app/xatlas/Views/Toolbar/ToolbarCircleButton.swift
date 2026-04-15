import SwiftUI

/// Glassy circular icon button used in the top toolbar. Hover brightens
/// the fill and scales up slightly; press shrinks via xatlasPressEffect.
struct ToolbarCircleButton: View {
    let icon: String
    let action: () -> Void
    @State private var isHovered = false

    init(icon: String, action: @escaping () -> Void = {}) {
        self.icon = icon
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.primary.opacity(0.55))
                .frame(width: XatlasLayout.controlSize, height: XatlasLayout.controlSize)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(isHovered ? XatlasSurface.controlFillHovered : XatlasSurface.controlFill)
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .stroke(.white.opacity(0.34), lineWidth: 1)
                )
        )
        .onHover { isHovered = $0 }
        .scaleEffect(isHovered ? 1.03 : 1.0)
        .animation(XatlasMotion.hover, value: isHovered)
        .xatlasPressEffect()
    }
}
