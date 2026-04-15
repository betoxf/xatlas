import SwiftUI

/// Uppercase section label with an optional trailing accessory (used for
/// "Projects" + the dashboard/workspace toggle).
struct SidebarSectionHeader<Accessory: View>: View {
    let title: String
    @ViewBuilder let accessory: () -> Accessory

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(XatlasFont.sectionLabel)
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
                .tracking(0.5)
            Spacer()
            accessory()
        }
        .padding(.horizontal, XatlasLayout.sidebarInset + 4)
        .padding(.bottom, 8)
    }
}
