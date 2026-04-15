import SwiftUI

/// Unified motion language for xatlas.
///
/// Springs for spatial transforms (scale, position) — they feel alive without
/// overshoot. Ease curves for opacity/color so they don't oscillate.
///
/// Pick the named role rather than the underlying curve so the language can
/// be tuned globally without combing through view code.
enum XatlasMotion {
    /// Hover and small reactive state changes. ~180ms perceived.
    static let hover = Animation.spring(response: 0.18, dampingFraction: 0.85)

    /// Press / tap-down feedback. Snappier than hover.
    static let press = Animation.spring(response: 0.12, dampingFraction: 0.9)

    /// Layout, expand/collapse, and panel-level transitions. ~280ms.
    static let layout = Animation.spring(response: 0.28, dampingFraction: 0.82)

    /// Slow / dramatic transitions (sheet present, mode switch). ~380ms.
    static let dramatic = Animation.spring(response: 0.38, dampingFraction: 0.78)

    /// Pure opacity / color. Spring-free.
    static let fade = Animation.easeOut(duration: 0.18)

    /// Quick fade for hover-only fills.
    static let fadeFast = Animation.easeOut(duration: 0.12)
}
