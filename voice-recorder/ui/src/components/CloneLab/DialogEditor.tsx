import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { SpeakerTag } from "./SpeakerTagExtension";

interface DialogEditorProps {
  onContentChange: (text: string, speakerNames: string[]) => void;
  activeSegmentIndex: number | null;
  disabled: boolean;
  placeholder: string;
}

interface SegmentRange {
  from: number;
  to: number;
}

/**
 * Walk the ProseMirror document and find segment ranges.
 * A segment is the text content between two consecutive speakerTag nodes
 * (or between a speakerTag and the end of the document).
 */
function findSegmentRanges(doc: any): SegmentRange[] {
  const segments: SegmentRange[] = [];
  let currentSegStart: number | null = null;

  doc.descendants((node: any, pos: number) => {
    if (node.type.name === "speakerTag") {
      // Close previous segment if any
      if (currentSegStart !== null) {
        // Segment ends just before this speaker tag
        segments.push({ from: currentSegStart, to: pos });
      }
      // New segment starts right after this tag
      currentSegStart = pos + node.nodeSize;
      return false; // don't descend into atom
    }
    return true;
  });

  // Close last segment
  if (currentSegStart !== null) {
    segments.push({ from: currentSegStart, to: doc.content.size });
  }

  return segments;
}

/**
 * Serialize the Tiptap document to plain text with [SpeakerName] tags.
 * Also extract unique speaker names.
 */
function serializeContent(editor: any): { text: string; speakerNames: string[] } {
  const doc = editor.state.doc;
  const parts: string[] = [];
  const names: string[] = [];

  doc.descendants((node: any) => {
    if (node.type.name === "speakerTag") {
      const name = node.attrs.name;
      parts.push(`[${name}]`);
      if (!names.includes(name)) names.push(name);
      return false;
    }
    if (node.isText) {
      parts.push(node.text);
      // Also extract [xxx] from plain text (fallback for IME/paste)
      const regex = /\[([^\]]+)\]/g;
      for (const m of node.text.matchAll(regex)) {
        if (m[1] && !names.includes(m[1])) names.push(m[1]);
      }
    }
    if (node.type.name === "paragraph") {
      // Add newline between paragraphs (but not before the first)
      if (parts.length > 0 && parts[parts.length - 1] !== "\n") {
        parts.push("\n");
      }
    }
    return true;
  });

  return { text: parts.join("").trim(), speakerNames: names };
}

const highlightPluginKey = new PluginKey("segmentHighlight");

function createHighlightPlugin(activeSegmentIndex: number | null) {
  return new Plugin({
    key: highlightPluginKey,
    state: {
      init(_, state) {
        return buildDecorations(state.doc, activeSegmentIndex);
      },
      apply(tr, oldDecorations, _oldState, newState) {
        // Rebuild on doc change or when meta signal is present
        if (tr.docChanged || tr.getMeta(highlightPluginKey) !== undefined) {
          const idx = tr.getMeta(highlightPluginKey) ?? activeSegmentIndex;
          return buildDecorations(newState.doc, idx);
        }
        return oldDecorations;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

function buildDecorations(doc: any, activeIdx: number | null): DecorationSet {
  if (activeIdx === null || activeIdx < 0) return DecorationSet.empty;

  const segments = findSegmentRanges(doc);
  if (activeIdx >= segments.length) return DecorationSet.empty;

  const seg = segments[activeIdx]!;
  if (seg.from >= seg.to) return DecorationSet.empty;

  return DecorationSet.create(doc, [
    Decoration.inline(seg.from, seg.to, { class: "segment-active" }),
  ]);
}

export function DialogEditor({
  onContentChange,
  activeSegmentIndex,
  disabled,
  placeholder,
}: DialogEditorProps) {
  const prevActiveRef = useRef<number | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
      }),
      SpeakerTag,
      Placeholder.configure({ placeholder }),
    ],
    editable: !disabled,
    editorProps: {
      attributes: {
        class: "tiptap",
      },
    },
    onUpdate: ({ editor: e }) => {
      const { text, speakerNames } = serializeContent(e);
      onContentChange(text, speakerNames);
    },
  });

  // Update editable state when disabled changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  // Update highlight when activeSegmentIndex changes
  useEffect(() => {
    if (!editor) return;
    if (prevActiveRef.current === activeSegmentIndex) return;
    prevActiveRef.current = activeSegmentIndex;

    // Dispatch a transaction with meta to trigger decoration rebuild
    const tr = editor.state.tr.setMeta(highlightPluginKey, activeSegmentIndex);
    editor.view.dispatch(tr);
  }, [editor, activeSegmentIndex]);

  // Register the highlight plugin once
  const pluginRegistered = useRef(false);
  useEffect(() => {
    if (!editor || pluginRegistered.current) return;
    pluginRegistered.current = true;

    // Add the plugin to the editor's state
    const plugin = createHighlightPlugin(activeSegmentIndex);
    const state = editor.state.reconfigure({
      plugins: [...editor.state.plugins, plugin],
    });
    editor.view.updateState(state);
  }, [editor, activeSegmentIndex]);

  if (!editor) return null;

  return (
    <div className="dialog-editor">
      <EditorContent editor={editor} />
    </div>
  );
}

/**
 * Get speaker names from plain text (fallback for when editor isn't mounted yet)
 */
export function extractSpeakerNamesFromText(text: string): string[] {
  const regex = /\[([^\]]+)\]/g;
  const names: string[] = [];
  for (const match of text.matchAll(regex)) {
    if (match[1] && !names.includes(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
}
