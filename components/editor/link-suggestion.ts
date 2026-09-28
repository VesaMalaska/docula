
import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import tippy from 'tippy.js';
import type { Instance } from 'tippy.js';
import { SuggestionList } from './suggestion-list';
import { searchDocuments } from '@/lib/actions/document';
import { PluginKey } from '@tiptap/pm/state';

const tippyFn = typeof tippy === 'function' ? tippy : (tippy as unknown as { default: typeof tippy }).default;

export function createLinkSuggestionRenderer() {
  let component: ReactRenderer | undefined;
  let popup: Instance[] | undefined;

  const destroy = () => {
    if (popup?.[0]) {
      if (!popup[0].state.isDestroyed) {
        popup[0].destroy();
      }
      popup = undefined;
    }
    if (component) {
      component.destroy();
      component = undefined;
    }
  };

  return {
    onStart: (props: SuggestionProps) => {
      destroy();

      component = new ReactRenderer(SuggestionList, {
        props,
        editor: props.editor,
      });

      if (!props.clientRect) {
        return;
      }

      popup = tippyFn('body', {
        getReferenceClientRect: props.clientRect,
        appendTo: () => document.body,
        content: component.element,
        showOnCreate: true,
        interactive: true,
        trigger: 'manual',
        placement: 'bottom-start',
      });
    },

    onUpdate(props: SuggestionProps) {
      component?.updateProps(props);

      if (!props.clientRect) {
        return;
      }

      popup?.[0]?.setProps({
        getReferenceClientRect: props.clientRect,
      });
    },

    onKeyDown(props: SuggestionKeyDownProps) {
      if (props.event.key === 'Escape') {
        popup?.[0]?.hide();
        return true;
      }

      return (component?.ref as { onKeyDown?: (props: SuggestionKeyDownProps) => boolean } | null)?.onKeyDown?.(props) ?? false;
    },

    onExit() {
      destroy();
    },
  };
}

export const LinkSuggestion = Extension.create({
  name: 'linkSuggestion',

  addOptions() {
    return {
      suggestion: {
        char: '[',
        pluginKey: new PluginKey('linkSuggestion'),
        command: ({ editor, range, props }: any) => {
          // Find the extension instance to access its options
          const ext = editor.extensionManager.extensions.find((e: any) => e.name === 'linkSuggestion');
          const spaceId = ext?.options?.spaceId || 'unknown';

          // props has the item selected
          // We want to insert a link with the title
          // The range is the `[[...` text. We want to replace it.
          
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: 'text',
                text: props.title,
                marks: [
                  {
                    type: 'link',
                    attrs: {
                      href: `/space/${spaceId}/doc/${props.id}`,
                    },
                  },
                ],
              },
              {
                  type: 'text',
                  text: ' ',
              }
            ])
            .run();
        },
      },
      spaceId: '',
      currentDocId: '',
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        items: async ({ query }: { query: string }) => {
            // Trigger on '[', but we might want to check context if needed.
            // For now, simple search.
            const results = await searchDocuments(query, this.options.spaceId, this.options.currentDocId);
            return results;
        },
        render: createLinkSuggestionRenderer,
      }),
    ];
  },
});

