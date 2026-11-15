import AVFoundation
import SwiftUI

/// Full-screen camera that closes as soon as it reads an xatlas pairing code.
struct ScannerScreen: View {
    let onLink: (RemoteLink) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var access = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var cameraUnavailable = false
    @State private var rejectedCode = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            content
        }
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .background(.ultraThinMaterial, in: .circle)
            }
            .accessibilityLabel("Close")
            .padding(16)
        }
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var content: some View {
        switch access {
        case .authorized where !cameraUnavailable:
            QRScannerView { code in
                if let link = RemoteLink(string: code) {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    onLink(link)
                } else {
                    rejectedCode = true
                }
            } onUnavailable: {
                cameraUnavailable = true
            }
            .ignoresSafeArea()
            .overlay { Viewfinder() }
            .overlay(alignment: .bottom) {
                Text(rejectedCode ? "That code isn't an xatlas pairing code." : "Point the camera at the code in Mobile remote control on your Mac.")
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(.ultraThinMaterial, in: .capsule)
                    .padding(24)
            }
        case .notDetermined:
            ProgressView()
                .task {
                    access = await AVCaptureDevice.requestAccess(for: .video) ? .authorized : .denied
                }
        default:
            ScannerMessage(
                title: cameraUnavailable ? "No camera here" : "Camera access is off",
                message: cameraUnavailable
                    ? "Copy the link from Mobile remote control on your Mac and paste it instead."
                    : "Allow camera access for xatlas in Settings to scan the pairing code.",
                action: cameraUnavailable ? nil : ("Open Settings", {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                })
            )
        }
    }
}

private struct Viewfinder: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 28, style: .continuous)
            .strokeBorder(.white.opacity(0.9), lineWidth: 3)
            .frame(width: 250, height: 250)
            .shadow(color: .black.opacity(0.35), radius: 12)
            .accessibilityHidden(true)
    }
}

private struct ScannerMessage: View {
    let title: String
    let message: String
    let action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "camera")
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text(title).font(.title3.weight(.semibold))
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let action {
                Button(action.0, action: action.1)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .padding(.top, 6)
            }
        }
        .padding(32)
        .frame(maxWidth: 420)
    }
}

/// AVFoundation QR reader; reports each distinct code once.
private struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onUnavailable: () -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        QRScannerController(onCode: onCode, onUnavailable: onUnavailable)
    }

    func updateUIViewController(_ controller: QRScannerController, context: Context) {}
}

private final class QRScannerController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.xatlas.ios.scanner")
    private let onCode: (String) -> Void
    private let onUnavailable: () -> Void
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var lastCode: String?

    init(onCode: @escaping (String) -> Void, onUnavailable: @escaping () -> Void) {
        self.onCode = onCode
        self.onUnavailable = onUnavailable
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let output = AVCaptureMetadataOutput()
        guard
            let camera = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: camera),
            session.canAddInput(input),
            session.canAddOutput(output)
        else {
            onUnavailable()
            return
        }
        session.addInput(input)
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        previewLayer = preview
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        nonisolated(unsafe) let session = session
        sessionQueue.async { if !session.inputs.isEmpty { session.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        nonisolated(unsafe) let session = session
        sessionQueue.async { session.stopRunning() }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue,
            code != lastCode
        else { return }
        lastCode = code
        onCode(code)
    }
}
