import SwiftUI

/// The detail side of the split view. Shows a placeholder until a memory is
/// opened or a new one is started, then the editor.
struct DetailPane: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ZStack {
            if model.showSettings {
                StorageSettingsView(isEmbedded: true)
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            } else if model.isEditorOpen {
                EditorView(editor: model.editor)
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            } else {
                placeholder
                    .transition(.opacity)
            }

            if model.isMemoryLoading {
                ProgressView()
                    .controlSize(.large)
                    .padding(22)
                    .glassSurface(cornerRadius: Metric.radiusPanel)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: model.showSettings || model.isEditorOpen)
    }

    private var placeholder: some View {
        VStack(spacing: 20) {
            (Brand.image("empty-chest") ?? Image(systemName: "archivebox"))
                .resizable().scaledToFit().frame(maxWidth: 200, maxHeight: 200)
                .shadow(color: Brand.terracotta.opacity(0.25), radius: 30, y: 10)
            VStack(spacing: 6) {
                Text("Your memory, beautifully kept.")
                    .font(.title3.weight(.semibold))
                Text("Select a memory to view, or create a new one.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 20)
            .glassSurface(cornerRadius: Metric.radiusPanel)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
