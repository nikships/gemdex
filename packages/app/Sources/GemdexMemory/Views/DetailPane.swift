import SwiftUI

/// The detail side of the split view. Shows a placeholder until a memory is
/// opened or a new one is started, then the editor. The recall-by-example
/// ("similar") results appear as an inspector-style sheet over the editor.
struct DetailPane: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ZStack {
            BrandBackdrop()

            if model.isEditorOpen {
                EditorView()
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            } else {
                placeholder
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: model.isEditorOpen)
        .sheet(item: similarBinding) { _ in
            SimilarPanel().environmentObject(model)
        }
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
            HStack(spacing: 10) {
                Image(systemName: "sparkle.magnifyingglass")
                    .font(.title3)
                    .foregroundStyle(Brand.gold)
                Text(model.similar?.title ?? "Similar memories")
                    .font(.headline)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 26, height: 26)
                        .glassSurfaceInteractive(cornerRadius: 999)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
            }
            .padding(18)

            Divider().opacity(0.5)

            content
        }
        .frame(width: 440, height: 500)
        .background(BrandBackdrop())
    }

    @ViewBuilder
    private var content: some View {
        if let similar = model.similar {
            if similar.loading {
                VStack(spacing: 14) {
                    ProgressView().controlSize(.large)
                    Text("Finding similar memories…")
                        .font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = similar.errorMessage {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title).foregroundStyle(Brand.terracotta)
                    Text("Recall by example could not complete.")
                        .font(.callout.weight(.medium))
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
            } else if similar.results.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.title).foregroundStyle(.secondary)
                    Text("No similar memories found.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(similar.results) { result in
                            SimilarRow(result: result) {
                                dismiss()
                                Task { await model.openMemory(result.id) }
                            }
                        }
                    }
                    .padding(16)
                }
                .softScrollEdges()
            }
        }
    }
}

/// One row in the recall-by-example results, styled as an interactive glass card.
private struct SimilarRow: View {
    let result: RecallResult
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "doc.text")
                    .font(.callout)
                    .foregroundStyle(Brand.gold)
                Text(result.displayTitle)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Spacer()
                if let score = result.score {
                    Text(String(format: "%.3f", score))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Brand.sage.opacity(0.16)))
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .contentShape(RoundedRectangle(cornerRadius: Metric.radiusCard, style: .continuous))
            .glassSurfaceInteractive(cornerRadius: Metric.radiusCard, tint: hovering ? Brand.gold : nil)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
    }
}
