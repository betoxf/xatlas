import SwiftUI

/// Single chat bubble in the dashboard operator overlay. User messages
/// align right with an accent fill; assistant messages align left with a
/// glass fill. The asymmetric corner radii give them a chat-app silhouette.
struct OperatorBubble: View {
    let message: OperatorConsoleMessage

    var body: some View {
        HStack {
            if message.role == .user {
                Spacer(minLength: 80)
            }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 5) {
                Text(message.text)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(message.role == .user ? .white : .primary.opacity(0.84))
                    .lineSpacing(1.5)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(bubbleBackground)
            .frame(maxWidth: 420, alignment: message.role == .user ? .trailing : .leading)

            if message.role == .assistant {
                Spacer(minLength: 80)
            }
        }
    }

    @ViewBuilder
    private var bubbleBackground: some View {
        if message.role == .user {
            UnevenRoundedRectangle(
                topLeadingRadius: 18,
                bottomLeadingRadius: 18,
                bottomTrailingRadius: 6,
                topTrailingRadius: 18
            )
            .fill(Color.accentColor.opacity(0.9))
            .shadow(color: Color.accentColor.opacity(0.14), radius: 10, x: 0, y: 5)
        } else {
            UnevenRoundedRectangle(
                topLeadingRadius: 18,
                bottomLeadingRadius: 6,
                bottomTrailingRadius: 18,
                topTrailingRadius: 18
            )
            .fill(.white.opacity(0.74))
            .overlay(
                UnevenRoundedRectangle(
                    topLeadingRadius: 18,
                    bottomLeadingRadius: 6,
                    bottomTrailingRadius: 18,
                    topTrailingRadius: 18
                )
                .stroke(.white.opacity(0.58), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.05), radius: 8, x: 0, y: 4)
        }
    }
}
