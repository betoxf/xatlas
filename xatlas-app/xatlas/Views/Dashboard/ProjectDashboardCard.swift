import AppKit
import SwiftUI

/// A single project card in the dashboard grid. Renders the project
/// name + path + a small live tmux preview, and self-throttles the
/// preview refresh based on hover/selection/scene phase.
struct ProjectDashboardCard: View {
    let project: Project
    @Bindable var state: AppState
    let onQuickView: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var terminalService = TerminalService.shared
    @State private var previewText = "No terminal output yet."
    @State private var isHovered = false
    @State private var previewHistoryBySessionID: [String: String] = [:]
    @State private var previewSessionID: String?
    @State private var previewRefreshTask: Task<Void, Never>?
    private let previewRefreshInterval: Duration = .seconds(2.4)

    private var allSessions: [TerminalSession] {
        terminalService.liveSessionsForProject(project.id)
    }

    private var primarySession: TerminalSession? {
        if let previewSessionID,
           let matchingSession = allSessions.first(where: { $0.id == previewSessionID }) {
            return matchingSession
        }
        return preferredPreviewSession()
    }

    private var attentionCount: Int {
        state.projectAttentionCount(project.id)
    }

    private var isSelected: Bool {
        state.selectedProject?.id == project.id && state.projectSurfaceMode == .workspace
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(project.name)
                            .font(XatlasFont.largeTitle)
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        if attentionCount > 0 {
                            Text("\(attentionCount)")
                                .font(.system(size: 10, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .xatlasBadgeFill(tint: .red)
                        }
                    }

                    Text(project.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(XatlasFont.monoCaption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary.opacity(0.55))
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(previewIndicatorColor)
                        .frame(width: 6, height: 6)

                    Text("Live Preview")
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                }

                Text(previewText)
                    .font(.system(size: 6.9, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary.opacity(0.72))
                    .lineSpacing(0)
                    .frame(maxWidth: .infinity, minHeight: 42, maxHeight: 42, alignment: .topLeading)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .clipped()
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.black.opacity(0.04))
            )
        }
        .padding(15)
        .frame(maxWidth: .infinity, minHeight: 174, maxHeight: 174, alignment: .topLeading)
        .background(cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: XatlasLayout.panelCornerRadius, style: .continuous)
                .strokeBorder(strokeStyle, lineWidth: isSelected ? 1.4 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: XatlasLayout.panelCornerRadius, style: .continuous))
        .scaleEffect(isHovered ? 1.012 : 1.0)
        .offset(y: isHovered ? -1 : 0)
        .animation(XatlasMotion.hover, value: isHovered)
        .xatlasPressEffect()
        .onTapGesture {
            onQuickView()
        }
        .onHover { isHovered = $0 }
        .onAppear {
            syncPreviewSessionSelection()
            refreshPreview()
            refreshPreviewLoop()
        }
        .onDisappear(perform: stopPreviewLoop)
        .onChange(of: allSessions.map(\.id)) { _, _ in
            syncPreviewSessionSelection()
            refreshPreview()
            refreshPreviewLoop()
        }
        .onChange(of: state.quickViewSelectedSessionID(for: project.id)) { _, _ in
            syncPreviewSessionSelection()
            refreshPreview()
            refreshPreviewLoop()
        }
        .onChange(of: state.selectedTab?.id) { _, _ in
            syncPreviewSessionSelection()
            refreshPreview()
            refreshPreviewLoop()
        }
        .onChange(of: state.selectedProject?.id) { _, _ in
            syncPreviewSessionSelection()
            refreshPreviewLoop()
        }
        .onChange(of: state.projectSurfaceMode) { _, _ in
            refreshPreviewLoop()
        }
        .onChange(of: scenePhase) { _, _ in
            refreshPreviewLoop()
        }
        .onChange(of: isHovered) { _, _ in
            refreshPreviewLoop()
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: XatlasLayout.panelCornerRadius, style: .continuous)
            .fill(.white.opacity(isHovered || isSelected ? 0.62 : 0.48))
            .overlay(
                RoundedRectangle(cornerRadius: XatlasLayout.panelCornerRadius, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                .white.opacity(isHovered ? 0.34 : 0.22),
                                .white.opacity(0.0)
                            ],
                            startPoint: .top,
                            endPoint: UnitPoint(x: 0.5, y: 0.34)
                        )
                    )
                    .allowsHitTesting(false)
            )
            .shadow(color: .black.opacity(0.05), radius: 2, y: 1)
            .shadow(
                color: .black.opacity(isHovered ? 0.11 : isSelected ? 0.1 : 0.07),
                radius: isHovered ? 16 : 12,
                y: isHovered ? 8 : 6
            )
            .shadow(
                color: .black.opacity(isHovered ? 0.07 : 0.04),
                radius: isHovered ? 32 : 24,
                y: isHovered ? 18 : 14
            )
    }

    private var strokeStyle: AnyShapeStyle {
        if isSelected {
            return AnyShapeStyle(Color.accentColor.opacity(0.58))
        }
        return AnyShapeStyle(
            LinearGradient(
                colors: [
                    .white.opacity(0.78),
                    .white.opacity(0.26)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    private var previewIndicatorColor: Color {
        guard let primarySession else { return .secondary.opacity(0.45) }
        switch primarySession.activityState {
        case .running:
            return .green.opacity(0.82)
        case .idle:
            return .blue.opacity(0.72)
        case .detached:
            return .orange.opacity(0.76)
        case .error:
            return .red.opacity(0.78)
        case .exited:
            return .secondary.opacity(0.45)
        }
    }

    private var shouldAutoRefreshPreview: Bool {
        guard scenePhase == .active else { return false }
        guard let primarySession else { return false }
        if isHovered || isSelected {
            return true
        }
        return primarySession.activityState == .running
    }

    private func refreshPreview() {
        guard let session = primarySession else {
            previewText = "No terminal yet."
            return
        }

        guard let snapshot = TerminalService.shared.snapshot(for: session.id, lines: 18) else {
            previewText = DashboardPreviewFormatter.fallback(for: session)
            return
        }

        guard let nextPreview = DashboardPreviewFormatter.preview(from: snapshot) else {
            if let rememberedPreview = previewHistoryBySessionID[session.id], !rememberedPreview.isEmpty {
                previewText = rememberedPreview
                return
            }
            previewText = DashboardPreviewFormatter.fallback(for: session)
            return
        }

        previewHistoryBySessionID[session.id] = nextPreview
        previewText = nextPreview
    }

    private func refreshPreviewLoop() {
        stopPreviewLoop()
        guard shouldAutoRefreshPreview else { return }

        previewRefreshTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: previewRefreshInterval)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard shouldAutoRefreshPreview else { return }
                    refreshPreview()
                }
            }
        }
    }

    private func stopPreviewLoop() {
        previewRefreshTask?.cancel()
        previewRefreshTask = nil
    }

    private func syncPreviewSessionSelection() {
        previewSessionID = state.preferredProjectSessionID(
            for: project.id,
            availableSessionIDs: allSessions.map(\.id),
            fallbackSelection: previewSessionID
        )
    }

    private func preferredPreviewSession() -> TerminalSession? {
        allSessions.max(by: TerminalSession.recencyOrder)
    }
}

/// Pure helpers for turning a tmux pane snapshot into the short multi-line
/// preview text shown on a dashboard card.
enum DashboardPreviewFormatter {
    static func preview(from snapshot: String) -> String? {
        let lines = snapshot
            .components(separatedBy: .newlines)
            .map { $0.replacingOccurrences(of: "\t", with: "    ") }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .filter { !$0.allSatisfy { $0 == "─" || $0 == "_" || $0 == "-" || $0 == "·" } }
            .filter { !isPromptLike($0) }
            .map(compact)

        guard !lines.isEmpty else { return nil }
        return lines.suffix(6).joined(separator: "\n")
    }

    static func fallback(for session: TerminalSession) -> String {
        let directory = session.displayDirectory
        let lastCommand = session.lastCommand.map(compact)

        switch session.activityState {
        case .running:
            if let lastCommand {
                return "Running in \(directory)\n\(lastCommand)"
            }
            return "Running in \(directory)\nStreaming terminal output…"
        case .idle, .detached:
            if let lastCommand {
                return "Shell ready in \(directory)\nLast command: \(lastCommand)"
            }
            return "Shell ready in \(directory)\nWaiting for command…"
        case .error:
            return "Terminal unavailable\nCouldn't attach a tmux session."
        case .exited:
            return "Terminal closed\nOpen a new terminal to resume."
        }
    }

    private static func compact(_ line: String) -> String {
        let collapsed = line.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        if collapsed.count > 42 {
            return String(collapsed.prefix(42)) + "…"
        }
        return collapsed
    }

    private static func isPromptLike(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return true
        }
        if trimmed == ">" || trimmed.hasPrefix("> ") || trimmed.hasPrefix("› ") {
            return true
        }
        if trimmed.hasSuffix("$") || trimmed.hasSuffix("%") || trimmed.hasSuffix("#") {
            return true
        }
        return trimmed.contains("❯")
    }
}
