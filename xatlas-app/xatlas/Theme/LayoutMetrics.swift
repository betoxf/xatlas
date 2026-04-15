import AppKit
import SwiftUI

/// 4px-grid spacing tokens. Use these instead of inline magic numbers.
enum XatlasSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let xxxl: CGFloat = 32
}

enum XatlasLayout {
    static let windowPadding: CGFloat = XatlasSpacing.md
    static let panelGap: CGFloat = XatlasSpacing.md
    static let sidebarWidth: CGFloat = 248
    static let panelCornerRadius: CGFloat = 22
    static let sectionCornerRadius: CGFloat = 18
    static let controlCornerRadius: CGFloat = 12
    static let compactCornerRadius: CGFloat = 10
    static let trafficLightTopInset: CGFloat = 15
    static let trafficLightLeadingInset: CGFloat = 18
    static let trafficLightSpacing: CGFloat = 6
    static let trafficLightClearance: CGFloat = 56
    static let sidebarInset: CGFloat = 14
    static let contentInset: CGFloat = 14
    static let controlSize: CGFloat = 32
    static let compactControlSize: CGFloat = 24

    /// The window's outer corner radius, derived from the panel radius plus
    /// the surrounding gap so panel corners and window corners stay concentric.
    static let windowCornerRadius: CGFloat = panelCornerRadius + windowPadding
}

enum XatlasSurface {
    static let windowBackground = Color(nsColor: NSColor(white: 0.945, alpha: 1.0))
    static let panelFill = Color.white.opacity(0.76)
    static let panelStroke = Color.white.opacity(0.56)
    static let sectionFill = Color.white.opacity(0.52)
    static let sectionStroke = Color.white.opacity(0.34)
    static let controlFill = Color.white.opacity(0.5)
    static let controlFillHovered = Color.white.opacity(0.7)
    static let divider = Color.black.opacity(0.07)
    static let hoverFill = Color.black.opacity(0.045)

    static let panelEdgeTop = Color.white.opacity(0.92)
    static let panelEdgeBottom = Color.white.opacity(0.38)
    static let sectionEdgeTop = Color.white.opacity(0.62)
    static let sectionEdgeBottom = Color.white.opacity(0.22)
    static let specularTop = Color.white.opacity(0.40)
    static let specularSection = Color.white.opacity(0.24)
}

private struct XatlasSpecularHighlight: View {
    let radius: CGFloat
    var topOpacity: Double = 0.40
    var extent: Double = 0.34

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        .white.opacity(topOpacity),
                        .white.opacity(0.0)
                    ],
                    startPoint: .top,
                    endPoint: UnitPoint(x: 0.5, y: extent)
                )
            )
            .allowsHitTesting(false)
    }
}

extension View {
    /// Three-layer elevation: close seat, primary body, soft ambient.
    /// Used for all floating surfaces so they share a consistent depth language.
    func xatlasLayeredShadow(
        seat: Double = 0.06,
        body: Double = 0.09,
        ambient: Double = 0.06
    ) -> some View {
        self
            .shadow(color: .black.opacity(seat), radius: 2, y: 1)
            .shadow(color: .black.opacity(body), radius: 12, y: 6)
            .shadow(color: .black.opacity(ambient), radius: 28, y: 16)
    }

    /// Horizontal hairline that fades at both ends — avoids the hard-edge
    /// "ruler" look of a flat rectangle.
    func xatlasFadingDivider(opacity: Double = 0.09) -> some View {
        LinearGradient(
            colors: [.clear, .black.opacity(opacity), .clear],
            startPoint: .leading,
            endPoint: .trailing
        )
        .frame(height: 1)
    }

    func xatlasPanelSurface(radius: CGFloat = XatlasLayout.panelCornerRadius) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(XatlasSurface.panelFill)
                .overlay(
                    XatlasSpecularHighlight(radius: radius, topOpacity: 0.40)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .stroke(
                            LinearGradient(
                                colors: [
                                    XatlasSurface.panelEdgeTop,
                                    XatlasSurface.panelEdgeBottom
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 1
                        )
                )
                .xatlasLayeredShadow()
        )
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    func xatlasSectionSurface(
        radius: CGFloat = XatlasLayout.sectionCornerRadius,
        fill: Color = XatlasSurface.sectionFill,
        stroke: Color = XatlasSurface.sectionStroke
    ) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(fill)
                .overlay(
                    XatlasSpecularHighlight(radius: radius, topOpacity: 0.24, extent: 0.30)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .stroke(
                            LinearGradient(
                                colors: [
                                    XatlasSurface.sectionEdgeTop,
                                    XatlasSurface.sectionEdgeBottom
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 1
                        )
                )
        )
    }

    /// Accent-tinted selection fill — gradient + inner highlight + soft glow.
    /// Used for primary "selected" states like the sidebar's chosen project.
    func xatlasAccentSelectionFill(
        radius: CGFloat = XatlasLayout.controlCornerRadius
    ) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
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
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
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
        )
    }

    /// Neutral chip selection — used for the tab bar's active tab. Similar
    /// structure to a panel surface but shrunk down for control chrome.
    func xatlasChipSelectionFill(
        radius: CGFloat = XatlasLayout.controlCornerRadius
    ) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(.white.opacity(0.78))
                .overlay(
                    XatlasSpecularHighlight(radius: radius, topOpacity: 0.30, extent: 0.34)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    .white.opacity(0.85),
                                    .white.opacity(0.32)
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.7
                        )
                )
                .shadow(color: .black.opacity(0.07), radius: 3, y: 1)
                .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        )
    }

    /// Refined badge — gradient pill with inner highlight + colored glow.
    /// `tint` controls the badge color (red for attention, accent for counts).
    func xatlasBadgeFill(tint: Color) -> some View {
        background(
            Capsule(style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [tint.opacity(0.95), tint.opacity(0.75)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(.white.opacity(0.30), lineWidth: 0.6)
                )
                .shadow(color: tint.opacity(0.30), radius: 3, y: 1)
        )
    }

    /// Animated focus ring overlay — fades in when `isFocused` is true.
    /// Use as an `.overlay` on focusable controls so the glass aesthetic
    /// stays intact instead of relying on the system accent ring.
    func xatlasFocusRing(
        isFocused: Bool,
        radius: CGFloat = XatlasLayout.controlCornerRadius
    ) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(
                    Color.accentColor.opacity(isFocused ? 0.55 : 0.0),
                    lineWidth: 1.5
                )
                .shadow(
                    color: Color.accentColor.opacity(isFocused ? 0.20 : 0.0),
                    radius: 4
                )
                .animation(XatlasMotion.fade, value: isFocused)
        )
    }

    /// Press-down feedback — shrinks slightly and dims while the tap is
    /// held. Compose on top of any button without changing the underlying
    /// button style.
    func xatlasPressEffect(scale: CGFloat = 0.97) -> some View {
        modifier(XatlasPressEffect(scale: scale))
    }
}

private struct XatlasPressEffect: ViewModifier {
    @State private var isPressed = false
    var scale: CGFloat = 0.97

    func body(content: Content) -> some View {
        content
            .scaleEffect(isPressed ? scale : 1.0)
            .brightness(isPressed ? -0.03 : 0)
            .animation(XatlasMotion.press, value: isPressed)
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if !isPressed { isPressed = true }
                    }
                    .onEnded { _ in
                        isPressed = false
                    }
            )
    }
}
