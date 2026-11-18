import SwiftUI

/// First run: connect this phone to t3 mini on your computer by scanning its pairing QR code
/// (Settings → Devices → Connect a device) or pasting the link.
struct PairView: View {
    @Environment(AppModel.self) private var model
    @State private var link = ""
    @State private var scanning = false
    @State private var pairing = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 10) {
                        Image(systemName: "laptopcomputer.and.iphone")
                            .font(.system(size: 52))
                            .foregroundStyle(.tint)
                        Text("Connect to t3 mini")
                            .font(.title2.bold())
                        Text("On your computer, open t3 mini → Settings → Devices, choose **Tailscale (HTTPS)**, turn it on, and tap **Connect a device**. Keep Tailscale on, on this iPhone too.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 32)

                    if let notice = model.unpairedNotice, problem == nil {
                        Label(notice, systemImage: "exclamationmark.triangle")
                            .font(.callout)
                            .foregroundStyle(.orange)
                    }

                    Button {
                        scanning = true
                    } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(pairing)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Or paste the link")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                        TextField("https://…/pair?code=…", text: $link, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .padding(12)
                            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12))
                        Button {
                            Task { await pair(link) }
                        } label: {
                            Group {
                                if pairing { ProgressView() } else { Text("Connect") }
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty || pairing)
                    }

                    if let problem {
                        Text(problem)
                            .font(.callout)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(24)
            }
            .sheet(isPresented: $scanning) {
                QRScannerSheet { code in
                    scanning = false
                    link = code
                    Task { await pair(code) }
                }
            }
        }
    }

    private func pair(_ text: String) async {
        pairing = true
        problem = nil
        defer { pairing = false }
        do {
            try await model.pair(with: text)
        } catch {
            problem = error.localizedDescription
        }
    }
}
