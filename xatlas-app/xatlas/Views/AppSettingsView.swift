import SwiftUI

struct AppSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var preferences = AppPreferences.shared

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Settings")
                        .font(.system(size: 18, weight: .semibold))
                    Text("Project sync and project-level AI behavior.")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button("Done") {
                    dismiss()
                }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Capsule().fill(.white.opacity(0.55)))
                .accessibilityLabel("Close settings")
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)

            Form {
                Section("AI Sync") {
                    Toggle("Use AI-generated commit messages", isOn: $preferences.useAIForSync)

                    Picker("Provider", selection: $preferences.syncProvider) {
                        ForEach(AISyncProvider.allCases) { provider in
                            Text(provider.label).tag(provider)
                        }
                    }
                    .disabled(!preferences.useAIForSync)

                    Toggle("Push after sync", isOn: $preferences.pushAfterSync)

                    Text("Project sync uses the selected AI to write the commit message, then commits and optionally pushes.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .padding(.horizontal, 8)
        }
        .frame(width: 440, height: 250)
        .background(Color(nsColor: .windowBackgroundColor))
        .onExitCommand {
            dismiss()
        }
    }
}
