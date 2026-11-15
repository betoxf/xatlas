import SwiftUI

/// First run, or after forgetting a Mac: explains where the pairing code is and takes it.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var isScanning = false
    @State private var invalidLink = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 32)

            VStack(spacing: 36) {
                VStack(spacing: 18) {
                    Image("XatlasMark")
                        .resizable()
                        .frame(width: 96, height: 96)
                        .accessibilityHidden(true)
                    VStack(spacing: 8) {
                        Text("xatlas")
                            .font(.system(size: 34, weight: .semibold))
                        Text("Your projects and agents on the Mac, from your phone.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                }

                VStack(alignment: .leading, spacing: 14) {
                    Step(number: 1, text: "On your Mac, open xatlas and click Mobile remote control (the phone icon) in the top bar.")
                    Step(number: 2, text: "Scan the code it shows, or copy its link and paste it here.")
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 18))
            }

            Spacer(minLength: 32)

            VStack(spacing: 12) {
                Button {
                    isScanning = true
                } label: {
                    Label("Scan pairing code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)

                PasteButton(payloadType: String.self) { strings in
                    guard let link = strings.lazy.compactMap(RemoteLink.init(string:)).first else {
                        invalidLink = true
                        return
                    }
                    model.pair(with: link)
                }
                .buttonBorderShape(.capsule)
                .labelStyle(.titleAndIcon)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .fullScreenCover(isPresented: $isScanning) {
            ScannerScreen { link in
                isScanning = false
                model.pair(with: link)
            }
        }
        .alert("That isn't an xatlas pairing link", isPresented: $invalidLink) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Copy the link from Mobile remote control in xatlas on your Mac, then paste it again.")
        }
    }
}

private struct Step: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.footnote.weight(.semibold).monospacedDigit())
                .frame(width: 22, height: 22)
                .background(.tint.opacity(0.12), in: .circle)
            Text(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

#Preview {
    HomeView().environment(AppModel())
}
