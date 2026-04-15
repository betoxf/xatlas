import AppKit
import SwiftTerm

/// SwiftTerm's TerminalView subclassed with three observer hooks
/// (input observer for command-history tracking, input handler for tmux
/// pane writes, layout observer for re-attach attempts when the grid
/// resizes) plus drag-and-drop support for files and pasteboard images.
final class ManagedTerminalView: TerminalView {
    var inputObserver: ((String) -> Void)?
    var inputHandler: ((ArraySlice<UInt8>) -> Void)?
    var layoutObserver: (() -> Void)?

    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        registerForDraggedTypes([.fileURL, .URL, .tiff, .png])
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layoutObserver?()
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedShellFragments(from: sender.draggingPasteboard).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let fragments = droppedShellFragments(from: sender.draggingPasteboard)
        guard !fragments.isEmpty else { return false }
        window?.makeFirstResponder(self)
        insertDroppedText(fragments.joined(separator: " "))
        return true
    }

    private func insertDroppedText(_ text: String) {
        guard !text.isEmpty else { return }
        inputObserver?(text)
        inputHandler?(ArraySlice(text.utf8))
    }

    private func droppedShellFragments(from pasteboard: NSPasteboard) -> [String] {
        if let fileURLs = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !fileURLs.isEmpty {
            return fileURLs.map { $0.path.shellQuotedForTerminal() }
        }

        if let imageURL = writeDroppedImage(from: pasteboard) {
            return [imageURL.path.shellQuotedForTerminal()]
        }

        return []
    }

    private func writeDroppedImage(from pasteboard: NSPasteboard) -> URL? {
        guard let image = NSImage(pasteboard: pasteboard),
              let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let pngData = bitmap.representation(using: .png, properties: [:]) else {
            return nil
        }

        let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("xatlas-drops", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let fileURL = directory.appendingPathComponent("drop-\(UUID().uuidString).png")
        do {
            try pngData.write(to: fileURL, options: .atomic)
            return fileURL
        } catch {
            return nil
        }
    }
}
