// XatlasDirectHomeView.swift
// Purpose: Home screen when connected directly to xatlas macOS app over LAN.
// Follows the remodex design system — AppFont, status capsules, glass effects, cards.

import SwiftUI

struct XatlasDirectHomeView: View {
    @State private var direct = XatlasDirectService.shared
    @State private var selectedSession: XatlasSession?
    @State private var showScanner = false
    @State private var dotPulse = false
    @State private var isSidebarOpen = false
    @State private var sidebarDragOffset: CGFloat = 0
    @Environment(\.colorScheme) private var colorScheme

    private let sidebarWidth: CGFloat = 330
    private static let sidebarSpring = Animation.spring(response: 0.35, dampingFraction: 0.85)

    var body: some View {
        Group {
            switch direct.connectionState {
            case .disconnected:
                disconnectedSplash
            case .pairing, .connecting:
                connectingSplash
            case .connected:
                connectedLayout
            case .error(let message):
                errorSplash(message: message)
            }
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView(
                onBack: { showScanner = false },
                onScan: { _ in showScanner = false },
                onLANScan: { payload in
                    showScanner = false
                    Task { await direct.pairAndConnect(payload: payload) }
                }
            )
        }
        .sheet(item: $selectedSession) { session in
            XatlasTerminalSheet(session: session)
        }
    }

    // MARK: - Disconnected Splash (matches HomeEmptyStateView)

    private var disconnectedSplash: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 20) {
                appLogo

                statusCapsule(
                    color: Color(.tertiaryLabel),
                    label: "Not Connected"
                )

                Text("Open xatlas on your Mac, go to\nSettings → Remote Access, and scan the QR code.")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                primaryButton(title: "Scan QR Code", icon: "qrcode.viewfinder") {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    showScanner = true
                }

                if direct.isConfigured {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        Task { await direct.reconnect() }
                    } label: {
                        Text("Reconnect to \(direct.macHost)")
                            .font(AppFont.subheadline(weight: .semibold))
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 6)
                }
            }
            .frame(maxWidth: 280)

            Spacer()
            Spacer()
        }
    }

    // MARK: - Connecting Splash

    private var connectingSplash: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 20) {
                appLogo

                statusCapsule(color: .orange, label: "Connecting...", pulsing: true)

                Text(direct.macHost.isEmpty ? "Pairing with Mac..." : "\(direct.macHost):\(direct.mcpPort)")
                    .font(AppFont.mono(.caption))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 280)

            Spacer()
            Spacer()
        }
    }

    // MARK: - Error Splash

    private func errorSplash(message: String) -> some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 20) {
                appLogo

                statusCapsule(color: .red, label: "Connection Failed")

                Text(message)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                primaryButton(title: "Scan QR Code", icon: "qrcode.viewfinder") {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    showScanner = true
                }

                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    Task { await direct.reconnect() }
                } label: {
                    Text("Retry")
                        .font(AppFont.subheadline(weight: .semibold))
                        .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: 280)

            Spacer()
            Spacer()
        }
    }

    // MARK: - Connected Layout (sidebar + content)

    private var connectedLayout: some View {
        ZStack(alignment: .leading) {
            if sidebarVisible {
                projectSidebar
                    .frame(width: sidebarWidth)
            }

            mainSessionContent
                .offset(x: contentOffset)

            if sidebarVisible {
                (colorScheme == .dark ? Color.white : Color.black)
                    .opacity(0.08 * min(1, contentOffset / sidebarWidth))
                    .ignoresSafeArea()
                    .offset(x: contentOffset)
                    .allowsHitTesting(isSidebarOpen)
                    .onTapGesture {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        withAnimation(Self.sidebarSpring) {
                            isSidebarOpen = false
                            sidebarDragOffset = 0
                        }
                    }
            }
        }
        .simultaneousGesture(edgeDragGesture)
    }

    // MARK: - Project Sidebar

    private var projectSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 10) {
                Image("AppLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 26, height: 26)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                Text("xatlas")
                    .font(AppFont.title3(weight: .medium))

                Spacer()

                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 6, height: 6)
                    Text(direct.macHost)
                        .font(AppFont.mono(.caption2))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            Divider().padding(.horizontal, 16)

            // Project list
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(direct.projects) { project in
                        projectSection(project)
                    }

                    let orphans = direct.sessions.filter { $0.projectId.isEmpty }
                    if !orphans.isEmpty {
                        sidebarSectionHeader("Other Terminals")
                        ForEach(orphans) { session in
                            sidebarSessionRow(session)
                        }
                    }
                }
                .padding(.top, 8)
            }

            Divider().padding(.horizontal, 16)

            // Bottom actions
            HStack(spacing: 16) {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    showScanner = true
                } label: {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)

                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    Task { await direct.fetchWorkspaceState() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    direct.disconnect()
                } label: {
                    Text("Disconnect")
                        .font(AppFont.caption(weight: .medium))
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .background(Color(.systemBackground))
    }

    private func projectSection(_ project: XatlasProject) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sidebarSectionHeader(project.name)

            let sessions = direct.sessionsForProject(project.id)
            if sessions.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "terminal")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                    Text("No active terminals")
                        .font(AppFont.caption())
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            } else {
                ForEach(sessions) { session in
                    sidebarSessionRow(session)
                }
            }
        }
    }

    private func sidebarSectionHeader(_ title: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "folder.fill")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Text(title.uppercased())
                .font(AppFont.caption(weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 4)
    }

    private func sidebarSessionRow(_ session: XatlasSession) -> some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            withAnimation(Self.sidebarSpring) {
                isSidebarOpen = false
                sidebarDragOffset = 0
            }
            selectedSession = session
        } label: {
            HStack(spacing: 10) {
                // Status indicator
                ZStack {
                    Circle()
                        .fill(session.attention ? Color.orange : (session.state == "idle" ? Color.green : Color.blue))
                        .frame(width: 10, height: 10)
                    Circle()
                        .stroke(Color(.systemBackground), lineWidth: 1)
                        .frame(width: 10, height: 10)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(AppFont.subheadline(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    if !session.lastCommand.isEmpty {
                        Text("$ \(session.lastCommand)")
                            .font(AppFont.mono(.caption2))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                Text(session.state)
                    .font(AppFont.caption2(weight: .medium))
                    .foregroundStyle(session.state == "idle" ? .green : .blue)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(
                        Capsule().fill(
                            session.state == "idle"
                                ? Color.green.opacity(0.12)
                                : Color.blue.opacity(0.12)
                        )
                    )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
    }

    // MARK: - Main Content (when no session selected, show project overview)

    private var mainSessionContent: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if direct.projects.isEmpty && direct.sessions.isEmpty {
                    emptyProjectsView
                } else {
                    projectOverview
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        withAnimation(Self.sidebarSpring) {
                            isSidebarOpen.toggle()
                            sidebarDragOffset = 0
                        }
                    } label: {
                        TwoLineHamburgerIcon()
                            .foregroundStyle(colorScheme == .dark ? .white : .black)
                            .padding(8)
                            .contentShape(Circle())
                            .adaptiveGlass(.regular, in: Circle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyProjectsView: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "terminal.fill")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
                .padding(20)
                .background(
                    Circle().fill(Color.primary.opacity(0.06))
                )

            Text("No Projects Yet")
                .font(AppFont.title3(weight: .semibold))

            Text("Open a project in xatlas on your Mac\nto see it here.")
                .font(AppFont.subheadline())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                Task { await direct.fetchWorkspaceState() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise")
                    Text("Refresh")
                }
                .font(AppFont.body(weight: .semibold))
                .foregroundStyle(Color(.systemBackground))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color.primary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 40)

            Spacer()
            Spacer()
        }
    }

    private var projectOverview: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                ForEach(direct.projects) { project in
                    projectCard(project)
                }

                let orphans = direct.sessions.filter { $0.projectId.isEmpty }
                if !orphans.isEmpty {
                    projectCardGeneric(title: "Other Terminals", sessions: orphans)
                }

                // Connection status footer
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 6, height: 6)
                    Text("Connected to \(direct.macHost)")
                        .font(AppFont.mono(.caption2))
                        .foregroundStyle(.tertiary)
                }
                .padding(.top, 8)
                .padding(.bottom, 20)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
        }
        .refreshable {
            await direct.fetchWorkspaceState()
        }
    }

    private func projectCard(_ project: XatlasProject) -> some View {
        let sessions = direct.sessionsForProject(project.id)
        return projectCardGeneric(title: project.name, path: project.path, sessions: sessions)
    }

    private func projectCardGeneric(title: String, path: String? = nil, sessions: [XatlasSession]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 10) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(.blue)
                    .frame(width: 28, height: 28)
                    .background(Color.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(AppFont.headline(weight: .semibold))
                    if let path {
                        Text(path)
                            .font(AppFont.mono(.caption2))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                Spacer()

                Text("\(sessions.count)")
                    .font(AppFont.caption(weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color(.tertiarySystemFill).opacity(0.8), in: Capsule())
            }
            .padding(14)

            if sessions.isEmpty {
                HStack {
                    Text("No active terminals")
                        .font(AppFont.caption())
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
            } else {
                Divider().padding(.horizontal, 14)

                ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                    if index > 0 {
                        Divider().padding(.leading, 48)
                    }
                    sessionCardRow(session)
                }
                .padding(.bottom, 6)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.tertiarySystemFill).opacity(0.55))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }

    private func sessionCardRow(_ session: XatlasSession) -> some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            selectedSession = session
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "terminal")
                    .font(.system(size: 12))
                    .foregroundStyle(session.attention ? .orange : .green)
                    .frame(width: 24, height: 24)
                    .background(
                        Circle().fill(
                            (session.attention ? Color.orange : Color.green).opacity(0.12)
                        )
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(AppFont.subheadline(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    if !session.lastCommand.isEmpty {
                        Text("$ \(session.lastCommand)")
                            .font(AppFont.mono(.caption2))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                HStack(spacing: 4) {
                    Circle()
                        .fill(session.state == "idle" ? Color.green : Color.blue)
                        .frame(width: 6, height: 6)
                    Text(session.state)
                        .font(AppFont.caption2(weight: .medium))
                        .foregroundStyle(session.state == "idle" ? .green : .blue)
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Reusable Components

    private var appLogo: some View {
        Image("AppLogo")
            .resizable()
            .scaledToFit()
            .frame(width: 88, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .adaptiveGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func statusCapsule(color: Color, label: String, pulsing: Bool = false) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .scaleEffect(dotPulse && pulsing ? 1.4 : 1.0)
                .opacity(dotPulse && pulsing ? 0.6 : 1.0)
                .animation(
                    pulsing
                        ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true)
                        : .default,
                    value: dotPulse
                )

            Text(label)
                .font(AppFont.caption(weight: .medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(Capsule().fill(Color(.systemBackground)))
        .overlay(Capsule().stroke(Color.primary.opacity(0.08), lineWidth: 1))
        .onAppear { dotPulse = pulsing }
    }

    private func primaryButton(title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                Text(title)
                    .font(AppFont.body(weight: .semibold))
            }
            .foregroundStyle(Color(.systemBackground))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Color.primary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.top, 6)
    }

    // MARK: - Sidebar Geometry

    private var sidebarVisible: Bool {
        isSidebarOpen || sidebarDragOffset > 0
    }

    private var contentOffset: CGFloat {
        if isSidebarOpen {
            return max(0, sidebarWidth + sidebarDragOffset)
        }
        return max(0, sidebarDragOffset)
    }

    private var edgeDragGesture: some Gesture {
        DragGesture(minimumDistance: 15)
            .onChanged { value in
                if !isSidebarOpen {
                    guard value.startLocation.x < 80,
                          value.translation.width > 0,
                          abs(value.translation.width) > abs(value.translation.height) * 1.15 else { return }
                    sidebarDragOffset = max(0, value.translation.width)
                } else {
                    guard value.translation.width < 0,
                          abs(value.translation.width) > abs(value.translation.height) * 1.15 else { return }
                    sidebarDragOffset = min(0, value.translation.width)
                }
            }
            .onEnded { value in
                let threshold = sidebarWidth * 0.4
                if !isSidebarOpen {
                    let shouldOpen = value.translation.width > threshold
                        || value.predictedEndTranslation.width > sidebarWidth * 0.5
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    withAnimation(Self.sidebarSpring) {
                        isSidebarOpen = shouldOpen
                        sidebarDragOffset = 0
                    }
                } else {
                    let shouldClose = -value.translation.width > threshold
                        || -value.predictedEndTranslation.width > sidebarWidth * 0.5
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    withAnimation(Self.sidebarSpring) {
                        isSidebarOpen = !shouldClose
                        sidebarDragOffset = 0
                    }
                }
            }
    }
}

// MARK: - Terminal Sheet

struct XatlasTerminalSheet: View {
    let session: XatlasSession
    @State private var terminalOutput: String = ""
    @State private var commandText: String = ""
    @State private var isLoading = true
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    private let direct = XatlasDirectService.shared

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Session info header
                HStack(spacing: 10) {
                    Image(systemName: "terminal")
                        .font(.system(size: 12))
                        .foregroundStyle(.green)
                        .frame(width: 28, height: 28)
                        .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title)
                            .font(AppFont.subheadline(weight: .semibold))
                        if !session.cwd.isEmpty {
                            Text(session.cwd)
                                .font(AppFont.mono(.caption2))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()

                    HStack(spacing: 4) {
                        Circle()
                            .fill(session.state == "idle" ? Color.green : Color.blue)
                            .frame(width: 6, height: 6)
                        Text(session.state)
                            .font(AppFont.caption2(weight: .medium))
                            .foregroundStyle(session.state == "idle" ? .green : .blue)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        Capsule().fill(
                            (session.state == "idle" ? Color.green : Color.blue).opacity(0.12)
                        )
                    )
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color(.tertiarySystemFill).opacity(0.55))

                // Terminal output
                ScrollViewReader { proxy in
                    ScrollView {
                        if isLoading {
                            VStack(spacing: 12) {
                                ProgressView()
                                Text("Loading terminal output...")
                                    .font(AppFont.caption())
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                        } else {
                            Text(terminalOutput)
                                .font(.system(size: 11, weight: .regular, design: .monospaced))
                                .foregroundStyle(colorScheme == .dark ? .green : Color(.label))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .textSelection(.enabled)
                                .id("bottom")
                        }
                    }
                    .background(colorScheme == .dark ? Color.black : Color(.systemBackground))
                    .onChange(of: terminalOutput) { _, _ in
                        withAnimation(.easeOut(duration: 0.15)) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    }
                }

                Divider()

                // Command input
                HStack(spacing: 8) {
                    Text("$")
                        .font(AppFont.mono(.subheadline))
                        .foregroundStyle(.secondary)

                    TextField("Command...", text: $commandText)
                        .font(AppFont.mono(.subheadline))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { sendCommand() }

                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        sendCommand()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(commandText.isEmpty ? Color(.tertiaryLabel) : .primary)
                    }
                    .buttonStyle(.plain)
                    .disabled(commandText.isEmpty)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.bar)
            }
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        Task { await loadSnapshot() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            await loadSnapshot()
            direct.connectTerminalStream(sessionId: session.id) { data in
                if let text = String(data: data, encoding: .utf8) {
                    Task { @MainActor in
                        terminalOutput += text
                    }
                }
            }
        }
        .onDisappear {
            direct.disconnectTerminalStream()
        }
    }

    private func loadSnapshot() async {
        isLoading = true
        if let snapshot = await direct.fetchSnapshot(sessionId: session.id) {
            terminalOutput = snapshot
        }
        isLoading = false
    }

    private func sendCommand() {
        let cmd = commandText
        commandText = ""
        Task {
            _ = await direct.sendCommand(sessionId: session.id, command: cmd)
            try? await Task.sleep(nanoseconds: 500_000_000)
            await loadSnapshot()
        }
    }
}

// MARK: - Hamburger Icon (reused from ContentView)

private struct TwoLineHamburgerIcon: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            RoundedRectangle(cornerRadius: 1)
                .frame(width: 20, height: 2)
            RoundedRectangle(cornerRadius: 1)
                .frame(width: 10, height: 2)
        }
        .frame(width: 20, height: 14, alignment: .leading)
    }
}

