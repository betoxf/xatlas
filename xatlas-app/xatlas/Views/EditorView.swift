import SwiftUI
import AppKit

struct EditorView: View {
    let filePath: String
    @State private var content: String = ""
    @State private var hasChanges = false

    var body: some View {
        CodeEditorRepresentable(text: $content, hasChanges: $hasChanges)
            .onAppear { loadFile() }
            .safeAreaInset(edge: .top) {
                HStack {
                    Text(URL(fileURLWithPath: filePath).lastPathComponent)
                        .font(XatlasFont.monoSmall)
                        .foregroundStyle(.secondary)
                    if hasChanges {
                        Circle().fill(.orange).frame(width: 6, height: 6)
                    }
                    Spacer()
                    Button("Save") { saveFile() }
                        .keyboardShortcut("s", modifiers: .command)
                        .disabled(!hasChanges)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
    }

    private func loadFile() {
        content = (try? FileService.shared.readFile(at: filePath)) ?? ""
    }

    private func saveFile() {
        try? FileService.shared.writeFile(at: filePath, content: content)
        hasChanges = false
    }
}

struct CodeEditorRepresentable: NSViewRepresentable {
    @Binding var text: String
    @Binding var hasChanges: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        let textView = NSTextView()

        textView.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.backgroundColor = .clear
        textView.textColor = .white
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isRichText = false
        textView.allowsUndo = true
        textView.delegate = context.coordinator
        textView.isEditable = true
        textView.isSelectable = true

        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true

        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text {
            textView.string = text
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: CodeEditorRepresentable
        init(_ parent: CodeEditorRepresentable) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            parent.hasChanges = true
        }
    }
}
