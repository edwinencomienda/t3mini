import AVFoundation
import SwiftUI

/// The camera, looking for a QR code. Calls `found` once with the first code's text.
struct QRScannerSheet: View {
    let found: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var denied = false

    var body: some View {
        NavigationStack {
            Group {
                if denied {
                    ContentUnavailableView(
                        "Camera not available",
                        systemImage: "camera.fill",
                        description: Text("Allow the camera in Settings → t3 mini, or paste the link instead."))
                } else {
                    QRScannerView(found: found)
                        .ignoresSafeArea()
                        .overlay(alignment: .bottom) {
                            Text("Point at the QR code in t3 mini on your computer")
                                .font(.callout.weight(.medium))
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .background(.ultraThinMaterial, in: .capsule)
                                .padding(.bottom, 40)
                        }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task {
                switch AVCaptureDevice.authorizationStatus(for: .video) {
                case .authorized: break
                case .notDetermined: denied = !(await AVCaptureDevice.requestAccess(for: .video))
                default: denied = true
                }
                if AVCaptureDevice.default(for: .video) == nil { denied = true }
            }
        }
    }
}

private struct QRScannerView: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.found = found
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var found: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var done = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input)
        else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // startRunning blocks, so off the main thread. AVCaptureSession is thread-safe.
        nonisolated(unsafe) let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session.stopRunning()
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
        // Delivered on the main queue (set above).
        MainActor.assumeIsolated {
            guard !done, let text else { return }
            done = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            found?(text)
        }
    }
}
