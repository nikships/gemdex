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
                VStack(alignment: .leading, spacing: 18) {
                    TextField("Title (optional — auto-derived if blank)", text: titleBinding)
                        .textFieldStyle(.plain)
                        .font(.title.weight(.bold))

                    ContentTextEditor(text: contentBinding)

                    AttachmentsSection()
                }
                .padding(28)
            }
            .softScrollEdges()

            footer
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text(editor.metaText)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if editor.isEditingExisting {
                Button(role: .destructive) { showDeleteConfirm = true } label: {
                    Label("Delete", systemImage: "trash")
                        .font(.callout.weight(.medium))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .foregroundStyle(Brand.terracotta)
                        .glassSurfaceInteractive(cornerRadius: Metric.radiusControl)
                }
                .buttonStyle(.plain)
                .confirmationDialog("Delete this memory? This cannot be undone.", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) { Task { await model.deleteSelected() } }
                    Button("Cancel", role: .cancel) {}
                }
            }
            Button {
                Task { await editor.save() }
            } label: {
                HStack(spacing: 6) {
                    if editor.isSaving {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "checkmark.circle.fill")
                    }
                    Text("Save")
                }
            }
            .brandPrimary()
            .keyboardShortcut("s", modifiers: .command)
            .disabled(editor.isSaving)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) { Divider().opacity(0.5) }
    }

    // Bind through the ObservableObject editor.
    private var titleBinding: Binding<String> {
        Binding(get: { editor.title }, set: { editor.title = $0 })
    }
    private var contentBinding: Binding<String> {
        Binding(get: { editor.content }, set: { editor.content = $0 })
    }
}

/// A monospace-friendly multiline text editor for memory content that expands to fit text.
struct ContentTextEditor: View {
    @Binding var text: String

    var body: some View {
        ZStack(alignment: .topLeading) {
            AutoExpandingTextViewRepresentable(text: $text)
                .frame(maxWidth: .infinity)
            
            if text.isEmpty {
                Text("Memory content. A one-line fact or a 300-line playbook — anything.")
                    .font(.system(.body, design: .default))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 8)
                    .allowsHitTesting(false)
            }
        }
        .padding(14)
        .glassSurface(cornerRadius: Metric.radiusCard)
    }
}

/// Bridge AppKit NSTextView to SwiftUI for high-performance auto-expanding text input.
struct AutoExpandingTextViewRepresentable: NSViewRepresentable {
    @Binding var text: String

    func makeNSView(context: Context) -> AutoGrowingTextView {
        let textView = AutoGrowingTextView()
        textView.isEditable = true
        textView.isSelectable = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude)
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        textView.focusRingType = .none
        textView.delegate = context.coordinator
        return textView
    }

    func updateNSView(_ nsView: AutoGrowingTextView, context: Context) {
        if nsView.string != text {
            nsView.string = text
            nsView.invalidateIntrinsicContentSize()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, NSTextViewDelegate {
        var parent: AutoExpandingTextViewRepresentable
        init(_ parent: AutoExpandingTextViewRepresentable) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

class AutoGrowingTextView: NSTextView {
    override var intrinsicContentSize: NSSize {
        guard let layoutManager = textContainer?.layoutManager,
              let textContainer = textContainer else {
            return super.intrinsicContentSize
        }
        layoutManager.ensureLayout(for: textContainer)
        let size = layoutManager.usedRect(for: textContainer).size
        return NSSize(width: NSView.noIntrinsicMetric, height: max(size.height, 220))
    }

    override func didChangeText() {
        super.didChangeText()
        self.invalidateIntrinsicContentSize()
    }
}
