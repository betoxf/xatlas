import SwiftUI

enum XatlasFont {
    // Headings
    static let largeTitle = Font.system(size: 16, weight: .semibold)
    static let title = Font.system(size: 14, weight: .semibold)
    static let heading = Font.system(size: 13, weight: .semibold)

    // Body
    static let body = Font.system(size: 13, weight: .regular)
    static let bodyMedium = Font.system(size: 13, weight: .medium)
    static let bodyEmphasized = Font.system(size: 13, weight: .semibold)

    // Captions
    static let caption = Font.system(size: 11, weight: .medium)
    static let captionEmphasized = Font.system(size: 11, weight: .semibold)
    static let captionSmall = Font.system(size: 10, weight: .medium)

    // Mono
    static let mono = Font.system(.body, design: .monospaced)
    static let monoSmall = Font.system(.caption, design: .monospaced)
    static let monoCaption = Font.system(size: 10, weight: .medium, design: .monospaced)

    // Special
    static let badge = Font.system(size: 9, weight: .bold, design: .rounded)
    static let sectionLabel = Font.system(size: 11, weight: .semibold)

    // Legacy aliases (kept to avoid churn in less-touched views)
    static let sidebar = body
    static let sidebarCaption = caption
}

enum XatlasIconWeight {
    static func standard(forSize size: CGFloat) -> Font.Weight {
        if size <= 9 { return .semibold }
        if size <= 14 { return .medium }
        return .regular
    }
}
