import SwiftUI
import AVFoundation

/// QR code scanner that reads xatlas pairing payload and auto-connects.
struct QRScannerView: UIViewControllerRepresentable {
    let onScanned: (QRPairingPayload) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onScanned = onScanned
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

struct QRPairingPayload: Codable {
    let host: String
    let port: Int
    let streamPort: Int
    let code: String
}

@MainActor
final class QRScannerViewController: UIViewController {
    var onScanned: ((QRPairingPayload) -> Void)?

    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasScanned = false
    private let metadataDelegate = MetadataDelegate()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        metadataDelegate.owner = self
        setupCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if let session = captureSession, !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession?.stopRunning()
    }

    private func setupCamera() {
        let session = AVCaptureSession()

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            showNoCameraLabel()
            return
        }

        guard session.canAddInput(input) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)

        output.setMetadataObjectsDelegate(metadataDelegate, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        captureSession = session

        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    private func showNoCameraLabel() {
        let label = UILabel()
        label.text = "Camera not available"
        label.textColor = .white
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    fileprivate func handleScannedPayload(_ payload: QRPairingPayload) {
        guard !hasScanned else { return }
        hasScanned = true
        captureSession?.stopRunning()

        let generator = UINotificationFeedbackGenerator()
        generator.notificationOccurred(.success)

        onScanned?(payload)
    }
}

// Separate non-isolated delegate to satisfy AVCaptureMetadataOutputObjectsDelegate
final class MetadataDelegate: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    weak var owner: QRScannerViewController?

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput,
                                    didOutput metadataObjects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let string = object.stringValue,
              let data = string.data(using: .utf8),
              let payload = try? JSONDecoder().decode(QRPairingPayload.self, from: data) else { return }

        DispatchQueue.main.async { [weak self] in
            self?.owner?.handleScannedPayload(payload)
        }
    }
}
