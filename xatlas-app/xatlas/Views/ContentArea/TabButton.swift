import SwiftUI

/// One pill in the workspace tab bar. Wraps a select-button and a
/// close-button (only visible while selected). The chip background gets
/// the same panel-language treatment (specular + gradient stroke +
/// shadow) when the tab is the active one.
struct TabButton: View {
    let title: String
    let isTerminal: Bool
    let requiresAttention: Bool
    let isSelected: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Button(action: onSelect) {
                HStack(spacing: 4) {
                    Image(systemName: isTerminal ? "terminal" : "doc.text")
                        .font(.system(size: 10, weight: .medium))

                    Text(title)
                        .font(XatlasFont.monoSmall)
                        .lineLimit(1)

                    if requiresAttention {
                        Text("1")
                            .font(XatlasFont.badge)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .xatlasBadgeFill(tint: .red)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
            }
            .buttonStyle(.plain)
            .opacity(isSelected ? 0.6 : 0)
            .xatlasPressEffect(scale: 0.85)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(chipBackground)
        .contentShape(Rectangle())
        .animation(XatlasMotion.layout, value: isSelected)
    }

    @ViewBuilder
    private var chipBackground: some View {
        if isSelected {
            RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                .fill(.white.opacity(0.78))
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [.white.opacity(0.30), .white.opacity(0.0)],
                                startPoint: .top,
                                endPoint: UnitPoint(x: 0.5, y: 0.34)
                            )
                        )
                        .allowsHitTesting(false)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: XatlasLayout.controlCornerRadius, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [.white.opacity(0.85), .white.opacity(0.32)],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.7
                        )
                )
                .shadow(color: .black.opacity(0.07), radius: 3, y: 1)
                .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        } else {
            Color.clear
        }
    }
}
