import AppKit
import SwiftUI

enum XatlasLayout {
    static let windowPadding: CGFloat = 12
    static let panelGap: CGFloat = 12
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
}

extension View {
    func xatlasPanelSurface(radius: CGFloat = XatlasLayout.panelCornerRadius) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(XatlasSurface.panelFill)
                .overlay(
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .stroke(XatlasSurface.panelStroke, lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.10), radius: 20, y: 10)
                .shadow(color: .black.opacity(0.05), radius: 5, y: 2)
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
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .stroke(stroke, lineWidth: 1)
                )
        )
    }
}
