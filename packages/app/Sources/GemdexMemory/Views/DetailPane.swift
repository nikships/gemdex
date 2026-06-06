import SwiftUI

/// The detail side of the split view. Shows a placeholder until a memory is
/// opened or a new one is started, then the editor. The recall-by-example
/// ("similar") results appear as an inspector-style sheet over the editor.
struct DetailPane: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ZStack {
            if model.isEditorOpen {
                EditorView()
            } else {
                placeholder
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VisualEffectBackground(material: .contentBackground).ignoresSafeArea())
        .sheet(item: similarBinding) { _ in
            SimilarPanel().environmentObject(model)
        }
    }

    private var placeholder: some View {
        VStack(spacing: 16) {
            (Brand.image("empty-chest") ?? Image(systemName: "archivebox"))
                .resizable().scaledToFit().frame(maxWidth: 200, maxHeight: 200)
                .opacity(0.9)
            Text("Select a memory to view, or create a new one.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Drive the sheet off whether `similar` is set.
    private var similarBinding: Binding<SimilarIdentifier?> {
        Binding(
            get: { model.similar == nil ? nil : SimilarIdentifier() },
            set: { if $0 == nil { model.similar = nil } }
        )
    }
}

struct SimilarIdentifier: Identifiable { let id = UUID() }

/// Recall-by-example results, shown in a sheet.
struct SimilarPanel: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(model.similar?.title ?? "Similar memories")
                    .font(.headline)
                Spacer()
                Button("Close") { dismiss() }
            }
            .padding()
            Divider()

            if let similar = model.similar {
                if similar.loading {
                    ProgressView("Finding similar memories…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = similar.errorMessage {
                    VStack(spacing: 10) {
                        Text("Recall by example could not complete.")
                            .font(.callout)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding()
                } else if similar.results.isEmpty {
                    Text("No similar memories found.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(similar.results) { result in
                        Button {
                            dismiss()
                            Task { await model.openMemory(result.id) }
                        } label: {
                            HStack {
                                Text(result.displayTitle).lineLimit(1)
                                Spacer()
                                if let score = result.score {
                                    Text(String(format: "%.3f", score))
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(width: 420, height: 480)
    }
}
