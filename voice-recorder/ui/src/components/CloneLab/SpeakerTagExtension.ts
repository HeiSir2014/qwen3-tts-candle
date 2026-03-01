import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

export const SpeakerTag = Node.create({
  name: "speakerTag",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      name: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="speaker-tag"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "speaker-tag",
        class: "speaker-tag",
      }),
      HTMLAttributes.name,
    ];
  },

  addProseMirrorPlugins() {
    const speakerTagType = this.type;
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;

          const { doc } = newState;
          const replacements: { from: number; to: number; name: string }[] = [];

          doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return;

            const regex = /\[([^\]]+)\]/g;
            let match;
            while ((match = regex.exec(node.text)) !== null) {
              replacements.push({
                from: pos + match.index,
                to: pos + match.index + match[0].length,
                name: match[1]!,
              });
            }
          });

          if (replacements.length === 0) return null;

          const tr = newState.tr;
          // Apply in reverse order to preserve positions
          for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i]!;
            tr.replaceWith(r.from, r.to, speakerTagType.create({ name: r.name }));
          }

          return tr;
        },
      }),
    ];
  },
});
