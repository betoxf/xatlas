import SwiftUI

/// The bottom operator surface on the dashboard. Collapses to a small
/// drag-handle dock; expands into a glassy chat tray with text input,
/// scroll-back of recent operator messages, and an add-project shortcut.
struct DashboardOperatorOverlay: View {
    let messages: [OperatorConsoleMessage]
    let isReady: Bool
    @Binding var input: String
    @Binding var isCollapsed: Bool
    var isFocused: FocusState<Bool>.Binding
    let addProject: () -> Void
    let send: () -> Void
    let activateInput: () -> Void
    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if isCollapsed {
                collapsedDock
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
                if !messages.isEmpty {
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(messages) { message in
                                OperatorBubble(message: message)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                    }
                    .frame(maxHeight: 132)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 2)
                }

                VStack(alignment: .leading, spacing: 10) {
                    operatorHandle

                    HStack(alignment: .bottom, spacing: 10) {
                        Button(action: addProject) {
                            Image(systemName: "plus")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(.primary.opacity(0.58))
                                .frame(width: 28, height: 28)
                        }
                        .buttonStyle(.plain)

                        TextField(placeholder, text: $input, axis: .vertical)
                            .textFieldStyle(.plain)
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1...4)
                            .focused(isFocused)
                            .onTapGesture {
                                if isCollapsed {
                                    expandTray()
                                } else {
                                    activateInput()
                                }
                            }
                            .onSubmit(send)

                        Button(action: send) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 24, weight: .semibold))
                                .foregroundStyle(
                                    input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                        ? Color.secondary.opacity(0.35)
                                        : Color.primary
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 12)
                .background(sheetBackground)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(.white.opacity(isInteractive ? 0.8 : 0.62), lineWidth: 1)
                )
                .shadow(color: .black.opacity(isInteractive ? 0.10 : 0.06), radius: isInteractive ? 18 : 12, y: 5)
                .shadow(color: .white.opacity(isInteractive ? 0.28 : 0.18), radius: 8, y: -2)
                .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .onTapGesture {
                    activateInput()
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity, alignment: .center)
        .onHover { isHovered = $0 }
        .animation(XatlasMotion.layout, value: isCollapsed)
    }

    private var isInteractive: Bool {
        isHovered || isFocused.wrappedValue
    }

    private var placeholder: String {
        isReady
            ? "Message the operator. Codex --yolo is running in the background…"
            : "Open the operator to start the background Codex session…"
    }

    private var sheetBackground: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(Color.white.opacity(isInteractive ? 0.97 : 0.91))
    }

    private var operatorHandle: some View {
        Capsule()
            .fill(Color.black.opacity(0.14))
            .frame(width: 48, height: 5)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .onTapGesture {
                collapseTray()
            }
            .gesture(
                DragGesture(minimumDistance: 8)
                    .onEnded { value in
                        if value.translation.height > 18 {
                            collapseTray()
                        } else if value.translation.height < -18 {
                            expandTray()
                        }
                    }
            )
    }

    private var collapsedDock: some View {
        Button(action: expandTray) {
            Capsule()
                .fill(Color.black.opacity(0.16))
                .frame(width: 42, height: 5)
                .frame(width: 78, height: 24)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.white.opacity(0.78))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(.white.opacity(0.56), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.06), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
    }

    private func collapseTray() {
        withAnimation(XatlasMotion.layout) {
            isCollapsed = true
        }
        isFocused.wrappedValue = false
    }

    private func expandTray() {
        withAnimation(XatlasMotion.layout) {
            isCollapsed = false
        }
        DispatchQueue.main.async {
            activateInput()
        }
    }
}
