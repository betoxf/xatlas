import SwiftUI

/// One nav row in the sidebar — icon + label + accent-tinted selected state.
struct SidebarItem: View {
    let icon: String
    let label: String
    let isSelected: Bool
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isSelected ? .white : .primary.opacity(0.5))
                    .frame(width: 20, alignment: .center)

                Text(label)
                    .font(XatlasFont.body)
                    .foregroundStyle(isSelected ? .white : .primary)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .background(SidebarSelectionBackground(isSelected: isSelected, isHovered: isHovered))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .animation(XatlasMotion.fadeFast, value: isHovered)
        .animation(XatlasMotion.layout, value: isSelected)
        .xatlasPressEffect()
    }
}

/// Shared background used by SidebarItem and SidebarProjectRow — accent
/// gradient + inner highlight + glow when selected, soft hover fill
/// otherwise. Lives in the Sidebar/ folder because it's tightly coupled
/// to those two row types and not a general theme primitive.
struct SidebarSelectionBackground: View {
    let isSelected: Bool
    let isHovered: Bool

    var body: some View {
        if isSelected {
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor,
                            Color.accentColor.opacity(0.84)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    .white.opacity(0.32),
                                    .white.opacity(0.04)
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.6
                        )
                )
                .shadow(color: Color.accentColor.opacity(0.22), radius: 6, y: 2)
                .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
        } else {
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(XatlasSurface.hoverFill.opacity(isHovered ? 1 : 0))
        }
    }
}
