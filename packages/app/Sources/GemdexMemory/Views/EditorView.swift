import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// The memory editor: title, content, attachments, and footer actions.
struct EditorView: View {
    @EnvironmentObject var model: AppModel
    @State private var showDeleteConfirm = false

    private var editor: EditorModel { model.editor }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField("Title (optional — auto-derived if blank)", text: titleBinding)
                        .textFieldStyle(.plain)
                        .font(.title2.weight(.semibold))

                    ContentTextEditor(text: contentBinding)
                        .frame(minHeight: 220)

                    AttachmentsSection()
                }
                .padding(24)
            }

            Divider()
            footer
        }
    }

    private var footer: some View {
        HStack {
            Text(editor.metaText)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if editor.isEditingExisting {
                Button(role: .destructive) { showDeleteConfirm = true } label: {
                    Label("Delete", systemImage: "trash")
                }
                .confirmationDialog("Delete this memory? This cannot be undone.", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) { Task { await model.deleteSelected() } }
                    Button("Cancel", role: .cancel) {}
                }
            }
            Button {
                Task { await editor.save() }
            } label: {
                HStack(spacing: 6) {
                    if editor.isSaving { ProgressView().controlSize(.small) }
                    Text("Save")
                }
            }
            .brandPrimary()
            .keyboardShortcut("s", modifiers: .command)
            .disabled(editor.isSaving)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
        .background(VisualEffectBackground(material: .titlebar))
    }

    // Bind through the ObservableObject editor.
    private var titleBinding: Binding<String> {
        Binding(get: { editor.title }, set: { editor.title = $0 })
    }
    private var contentBinding: Binding<String> {
        Binding(get: { editor.content }, set: { editor.content = $0 })
    }
}

/// A monospace-friendly multiline text editor for memory content.
struct ContentTextEditor: View {
    @Binding var text: String

    var body: some View {
        TextEditor(text: $text)
            .font(.system(.body, design: .default))
            .scrollContentBackground(.hidden)
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(nsColor: .textBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color(nsColor: .separatorColor))
            )
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text("Memory content. A one-line fact or a 300-line playbook — anything.")
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 18)
                        .allowsHitTesting(false)
                }
            }
    }
}
