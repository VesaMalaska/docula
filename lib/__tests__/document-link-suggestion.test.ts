import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Custom resolver hook to support extensionless TS imports and @/ alias in Node ESM
const rootUrl = pathToFileURL(process.cwd() + "/").href;
const hookCode = `
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.endsWith("suggestion-list") || specifier.endsWith("suggestion-list.tsx")) {
        return {
            url: "data:text/javascript," + encodeURIComponent("export const SuggestionList = () => null;"),
            format: "module",
            shortCircuit: true,
        };
    }
    if (specifier.startsWith("@/")) {
        const target = new URL(specifier.slice(2), "${rootUrl}").href;
        try {
            return await nextResolve(target, context);
        } catch {
            return await nextResolve(target + ".ts", context);
        }
    }
    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        if (specifier.startsWith(".") || specifier.startsWith("${rootUrl}")) {
            try {
                return await nextResolve(specifier + ".ts", context);
            } catch {}
        }
        throw err;
    }
}
`;
register("data:text/javascript," + encodeURIComponent(hookCode));

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as firestoreActual from "firebase/firestore";

mock.module("server-only", { exports: {} });

interface MockDocItem {
  id: string;
  data: {
    spaceId: string;
    title: string;
    deleted?: boolean;
    parentId?: string | null;
    path?: string[];
  };
}

let mockDocs: MockDocItem[] = [];

mock.module("firebase/firestore", {
  exports: {
    ...firestoreActual,
    collection: mock.fn((_db: unknown, name: string) => ({ name })),
    where: mock.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
    query: mock.fn((col: unknown, ...constraints: { field: string; op: string; value: unknown }[]) => ({
      col,
      constraints,
    })),
    getDocs: mock.fn(async (q: { constraints?: { field: string; op: string; value: unknown }[] }) => {
      const spaceConstraint = q?.constraints?.find((c) => c.field === "spaceId");
      const spaceId = spaceConstraint?.value;

      const filtered = mockDocs.filter((d) => !spaceId || d.data.spaceId === spaceId);

      return {
        forEach: (callback: (doc: { id: string; data: () => MockDocItem["data"] }) => void) => {
          filtered.forEach((d) => {
            callback({
              id: d.id,
              data: () => ({ ...d.data }),
            });
          });
        },
      };
    }),
  },
});

mock.module("@/lib/firebase", {
  exports: {
    db: {},
    auth: { currentUser: null },
  },
});

const { searchDocuments } = await import("../actions/document.ts");
const { LinkSuggestion, createLinkSuggestionRenderer } = await import("../../components/editor/link-suggestion.ts");

describe("Document Link Suggestions - Current Document Exclusion", () => {
  const SPACE_ID = "space-test-123";

  beforeEach(() => {
    mockDocs = [];
  });

  it("excludes current document A from suggestion candidates by ID", async () => {
    mockDocs = [
      { id: "doc-a", data: { spaceId: SPACE_ID, title: "Document A" } },
      { id: "doc-b", data: { spaceId: SPACE_ID, title: "Document B" } },
      { id: "doc-c", data: { spaceId: SPACE_ID, title: "Document C" } },
    ];

    const results = await searchDocuments("", SPACE_ID, "doc-a");

    assert.strictEqual(results.some((r) => r.id === "doc-a"), false);
    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(
      results.map((r) => r.id),
      ["doc-b", "doc-c"]
    );
  });

  it("preserves another document with the exact same title as the current document", async () => {
    mockDocs = [
      { id: "doc-current", data: { spaceId: SPACE_ID, title: "Project Overview" } },
      { id: "doc-sibling", data: { spaceId: SPACE_ID, title: "Project Overview" } },
      { id: "doc-other", data: { spaceId: SPACE_ID, title: "Meeting Notes" } },
    ];

    // Editing doc-current
    const results = await searchDocuments("", SPACE_ID, "doc-current");

    // doc-current must be absent
    assert.strictEqual(results.some((r) => r.id === "doc-current"), false);
    // doc-sibling must be present even though its title is identical
    const sameTitleMatch = results.find((r) => r.id === "doc-sibling");
    assert.ok(sameTitleMatch);
    assert.strictEqual(sameTitleMatch.title, "Project Overview");
    assert.strictEqual(results.length, 2);
  });

  it("excludes current document when it is nested in the document tree", async () => {
    mockDocs = [
      {
        id: "doc-nested-a",
        data: {
          spaceId: SPACE_ID,
          title: "Deeply Nested Child",
          parentId: "parent-folder-id",
          path: ["root-id", "parent-folder-id"],
        },
      },
      {
        id: "doc-root-b",
        data: {
          spaceId: SPACE_ID,
          title: "Root Level Document",
          parentId: null,
          path: [],
        },
      },
    ];

    const results = await searchDocuments("", SPACE_ID, "doc-nested-a");

    assert.strictEqual(results.some((r) => r.id === "doc-nested-a"), false);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, "doc-root-b");
  });

  it("continues to exclude current document when suggestions are filtered by typing", async () => {
    mockDocs = [
      { id: "doc-a", data: { spaceId: SPACE_ID, title: "Architecture RFC" } },
      { id: "doc-b", data: { spaceId: SPACE_ID, title: "Architecture Guidelines" } },
      { id: "doc-c", data: { spaceId: SPACE_ID, title: "Deployment RFC" } },
    ];

    // Query matches both doc-a and doc-b
    const results = await searchDocuments("architect", SPACE_ID, "doc-a");

    assert.strictEqual(results.some((r) => r.id === "doc-a"), false);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, "doc-b");
    assert.strictEqual(results[0].title, "Architecture Guidelines");
  });

  it("returns empty results when the space or query contains only the current document", async () => {
    mockDocs = [
      { id: "doc-only", data: { spaceId: SPACE_ID, title: "Solo Document" } },
    ];

    const results = await searchDocuments("", SPACE_ID, "doc-only");
    assert.deepStrictEqual(results, []);

    const filteredResults = await searchDocuments("solo", SPACE_ID, "doc-only");
    assert.deepStrictEqual(filteredResults, []);
  });

  it("preserves candidate ordering and candidate limit (up to 10) without current document taking a slot", async () => {
    // 11 documents with similar titles; doc-0 is the current doc with exact match
    mockDocs = [
      { id: "doc-0", data: { spaceId: SPACE_ID, title: "Spec" } },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `doc-${i + 1}`,
        data: { spaceId: SPACE_ID, title: `Spec Part ${i + 1}` },
      })),
    ];

    const results = await searchDocuments("Spec", SPACE_ID, "doc-0");

    // All 10 other docs should be returned
    assert.strictEqual(results.length, 10);
    assert.strictEqual(results.some((r) => r.id === "doc-0"), false);
    // Verify first result is doc-1
    assert.strictEqual(results[0].id, "doc-1");
  });

  it("preserves backward compatibility when currentDocId is omitted or undefined", async () => {
    mockDocs = [
      { id: "doc-a", data: { spaceId: SPACE_ID, title: "Document A" } },
      { id: "doc-b", data: { spaceId: SPACE_ID, title: "Document B" } },
    ];

    const resultsWithoutDocId = await searchDocuments("", SPACE_ID);
    assert.strictEqual(resultsWithoutDocId.length, 2);
    assert.strictEqual(resultsWithoutDocId.some((r) => r.id === "doc-a"), true);
  });

  it("LinkSuggestion extension accepts and configures currentDocId option", () => {
    const configured = LinkSuggestion.configure({
      spaceId: "space-xyz",
      currentDocId: "doc-active-123",
    });

    assert.strictEqual(configured.options.spaceId, "space-xyz");
    assert.strictEqual(configured.options.currentDocId, "doc-active-123");
  });

  it("LinkSuggestion items callback fetches search candidates excluding currentDocId", async () => {
    mockDocs = [
      { id: "doc-editing", data: { spaceId: SPACE_ID, title: "Current Being Edited" } },
      { id: "doc-other", data: { spaceId: SPACE_ID, title: "Target Sibling Document" } },
    ];

    const configured = LinkSuggestion.configure({
      spaceId: SPACE_ID,
      currentDocId: "doc-editing",
    });

    // Invoke addProseMirrorPlugins from extension config
    const addPlugins = LinkSuggestion.config.addProseMirrorPlugins;
    assert.ok(typeof addPlugins === "function");

    // Mock Suggestion plugin instantiation to capture items callback
    const plugins = addPlugins.call({
      editor: {} as never,
      options: configured.options,
    });

    assert.strictEqual(plugins.length, 1);
    const suggestionPlugin = plugins[0];
    assert.ok(suggestionPlugin);

    // Call searchDocuments with configured extension options
    const itemsResult = await searchDocuments("", configured.options.spaceId, configured.options.currentDocId);
    assert.strictEqual(itemsResult.some((r) => r.id === "doc-editing"), false);
    assert.strictEqual(itemsResult.length, 1);
    assert.strictEqual(itemsResult[0].id, "doc-other");
  });

  it("Suggestion insertion command formats correct link url and title for target document", () => {
    const spaceId = "space-demo";
    const targetDoc = { id: "doc-target-456", title: "Target Page Title" };
    let insertedContent: unknown = null;
    let focused = false;

    const mockEditor = {
      chain: () => ({
        focus: () => {
          focused = true;
          return {
            insertContentAt: (_range: unknown, content: unknown) => {
              insertedContent = content;
              return {
                run: () => true,
              };
            },
          };
        },
      }),
      extensionManager: {
        extensions: [
          {
            name: "linkSuggestion",
            options: { spaceId, currentDocId: "doc-current" },
          },
        ],
      },
    };

    const linkSuggestionInstance = LinkSuggestion.configure({
      spaceId,
      currentDocId: "doc-current",
    });

    const command = linkSuggestionInstance.options.suggestion.command;
    assert.ok(typeof command === "function");

    command({
      editor: mockEditor,
      range: { from: 1, to: 2 },
      props: targetDoc,
    });

    assert.strictEqual(focused, true);
    assert.deepStrictEqual(insertedContent, [
      {
        type: "text",
        text: "Target Page Title",
        marks: [
          {
            type: "link",
            attrs: {
              href: `/space/${spaceId}/doc/${targetDoc.id}`,
            },
          },
        ],
      },
      {
        type: "text",
        text: " ",
      },
    ]);
  });
});

describe("Document Link Suggestions - Tippy Lifecycle & Cleanup", () => {
  interface MockDomElement {
    nodeType: number;
    children: MockDomElement[];
    readonly firstElementChild: MockDomElement | undefined;
    hasAttribute: (name: string) => boolean;
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, val: string) => void;
    removeAttribute: (name: string) => void;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    querySelectorAll: (sel: string) => MockDomElement[];
    classList: { add: (...cls: string[]) => void; remove: (...cls: string[]) => void; contains: (cls: string) => boolean };
    style: Record<string, string>;
    appendChild: (child: MockDomElement) => MockDomElement;
    removeChild: (child: MockDomElement) => void;
    contains: (child: MockDomElement) => boolean;
    ownerDocument: unknown;
    _tippy?: {
      id: number;
      hide: () => void;
      destroy: () => void;
      state: { isDestroyed: boolean; isVisible: boolean };
    };
  }

  function createMockElement(): MockDomElement {
    const elem: MockDomElement = {
      nodeType: 1,
      children: [],
      get firstElementChild() {
        return this.children[0];
      },
      hasAttribute: () => false,
      getAttribute: () => null,
      setAttribute: () => {},
      removeAttribute: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
      classList: {
        add: () => {},
        remove: () => {},
        contains: () => false,
      },
      style: {},
      appendChild: (child) => {
        elem.children.push(child);
        return child;
      },
      removeChild: () => {},
      contains: () => false,
      ownerDocument: null,
    };
    elem.ownerDocument = mockDoc;
    return elem;
  }

  let bodyElem: MockDomElement;
  let mockDoc: {
    readonly body: MockDomElement;
    documentElement: { style: Record<string, string> };
    createElement: (tag: string) => MockDomElement;
    createElementNS: (ns: string, tag: string) => MockDomElement;
    createTextNode: (text: string) => MockDomElement;
    querySelectorAll: (sel: string) => MockDomElement[];
    addEventListener: () => void;
    removeEventListener: () => void;
  };

  const mockEditor = {
    isInitialized: false,
    contentComponent: {
      setRenderer: () => {},
      removeRenderer: () => {},
    },
    extensionManager: {
      extensions: [
        {
          name: "linkSuggestion",
          options: { spaceId: "space-lifecycle", currentDocId: "doc-lifecycle" },
        },
      ],
    },
    state: {
      selection: { $anchor: { pos: 0 } },
    },
    view: {
      coordsAtPos: () => ({ top: 0, left: 0, bottom: 10, right: 10 }),
      dom: null as unknown as MockDomElement,
    },
  };

  const clientRect = () =>
    ({
      top: 10,
      left: 20,
      bottom: 30,
      right: 40,
      width: 20,
      height: 20,
    }) as unknown as DOMRect;

  beforeEach(() => {
    bodyElem = createMockElement();
    mockDoc = {
      get body() {
        return bodyElem;
      },
      documentElement: { style: {} },
      createElement: () => createMockElement(),
      createElementNS: () => createMockElement(),
      createTextNode: () => createMockElement(),
      querySelectorAll: () => [bodyElem],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    mockEditor.view.dom = bodyElem;

    (globalThis as unknown as { document: unknown }).document = mockDoc;
    (globalThis as unknown as { window: unknown }).window = globalThis;
    (globalThis as unknown as { addEventListener: unknown }).addEventListener = () => {};
    (globalThis as unknown as { removeEventListener: unknown }).removeEventListener = () => {};
    (globalThis as unknown as { Element: unknown }).Element = class {};
    (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
  });

  it("prevents double destruction when suggestion session closes and editor unmounts", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const renderer = createLinkSuggestionRenderer();
      renderer.onStart({ editor: mockEditor as never, clientRect });

      const instance = bodyElem._tippy;
      assert.ok(instance, "Tippy instance must be attached to reference element");

      let destroyCount = 0;
      const originalDestroy = instance.destroy;
      instance.destroy = () => {
        destroyCount++;
        originalDestroy.call(instance);
      };

      // First exit: selection or dismissal in the editor
      renderer.onExit();
      assert.strictEqual(destroyCount, 1, "First onExit must destroy the active Tippy popup");
      assert.strictEqual(instance.state.isDestroyed, true, "Popup state must be marked destroyed");

      // Second exit: editor unmounts (TipTap Suggestion plugin view.destroy hook calls onExit)
      renderer.onExit();
      assert.strictEqual(destroyCount, 1, "Second onExit must NOT attempt to destroy the already-destroyed instance");
      assert.strictEqual(warnings.length, 0, "No Tippy memory leak or lifecycle warnings should be emitted");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("dismisses popup with Escape by hiding it, then cleans up cleanly on exit", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const renderer = createLinkSuggestionRenderer();
      renderer.onStart({ editor: mockEditor as never, clientRect });

      const instance = bodyElem._tippy;
      assert.ok(instance);

      let hideCount = 0;
      const originalHide = instance.hide;
      instance.hide = () => {
        hideCount++;
        originalHide.call(instance);
      };

      let destroyCount = 0;
      const originalDestroy = instance.destroy;
      instance.destroy = () => {
        destroyCount++;
        originalDestroy.call(instance);
      };

      const handled = renderer.onKeyDown({ event: { key: "Escape" } as KeyboardEvent });
      assert.strictEqual(handled, true, "Escape must be marked as handled");
      assert.strictEqual(hideCount, 1, "Escape must call hide() on the Tippy instance");
      assert.strictEqual(destroyCount, 0, "Escape should not immediately destroy the instance");

      // Moving cursor away or editor unmount closes session
      renderer.onExit();
      assert.strictEqual(destroyCount, 1, "Exit must destroy the popup once");

      // Subsequent editor unmount
      renderer.onExit();
      assert.strictEqual(destroyCount, 1, "Unmount after Escape dismissal must not double destroy");
      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("cleans up active popup when editor unmounts while popup is still open", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const renderer = createLinkSuggestionRenderer();
      renderer.onStart({ editor: mockEditor as never, clientRect });

      const instance = bodyElem._tippy;
      assert.ok(instance);

      let destroyCount = 0;
      const originalDestroy = instance.destroy;
      instance.destroy = () => {
        destroyCount++;
        originalDestroy.call(instance);
      };

      // User navigates away while popup is still open: editor unmount calls onExit directly
      renderer.onExit();
      assert.strictEqual(destroyCount, 1, "Unmounting while open must clean up active popup");
      assert.strictEqual(instance.state.isDestroyed, true);

      // Repeated exit call is a safe no-op
      renderer.onExit();
      assert.strictEqual(destroyCount, 1);
      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("handles repeated open and close suggestion cycles without double destroying any instance", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const renderer = createLinkSuggestionRenderer();

      // Cycle 1
      renderer.onStart({ editor: mockEditor as never, clientRect });
      const inst1 = bodyElem._tippy;
      assert.ok(inst1);
      let dest1 = 0;
      const origDest1 = inst1.destroy;
      inst1.destroy = () => {
        dest1++;
        origDest1.call(inst1);
      };
      renderer.onExit();
      assert.strictEqual(dest1, 1);

      // Cycle 2
      renderer.onStart({ editor: mockEditor as never, clientRect });
      const inst2 = bodyElem._tippy;
      assert.ok(inst2);
      assert.notStrictEqual(inst1, inst2, "Cycle 2 must create a new Tippy instance");
      let dest2 = 0;
      const origDest2 = inst2.destroy;
      inst2.destroy = () => {
        dest2++;
        origDest2.call(inst2);
      };
      renderer.onExit();
      assert.strictEqual(dest2, 1);

      // Final unmount of editor
      renderer.onExit();
      assert.strictEqual(dest1, 1, "First instance must not be destroyed again");
      assert.strictEqual(dest2, 1, "Second instance must not be destroyed again");
      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("safely handles missing clientRect without crashing or leaking", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const renderer = createLinkSuggestionRenderer();
      // onStart with null clientRect
      renderer.onStart({ editor: mockEditor as never, clientRect: null as never });

      // onUpdate with null clientRect
      renderer.onUpdate({ editor: mockEditor as never, clientRect: null as never });

      // onKeyDown with Escape
      const handled = renderer.onKeyDown({ event: { key: "Escape" } as KeyboardEvent });
      assert.strictEqual(handled, true);

      // onExit must not throw
      renderer.onExit();
      renderer.onExit();

      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("handles a clientRect callback that returns null during start and update without violating Tippy contract", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const renderer = createLinkSuggestionRenderer();

      // clientRect callback that returns null initially
      let currentRect: DOMRect | null = null;
      const clientRectCallback = () => currentRect;

      renderer.onStart({ editor: mockEditor as never, clientRect: clientRectCallback });

      const instance = bodyElem._tippy;
      assert.ok(instance, "Tippy instance should be created when clientRect callback is provided");

      // Verify that Tippy getReferenceClientRect returns a non-null rect even when cursor rect is null
      const rect1 = (instance as { props: { getReferenceClientRect: () => DOMRect } }).props.getReferenceClientRect();
      assert.ok(rect1, "getReferenceClientRect must never return null");
      assert.strictEqual(rect1.width, 0);
      assert.strictEqual(rect1.height, 0);

      // onUpdate while cursor rect is still null
      renderer.onUpdate({ editor: mockEditor as never, clientRect: clientRectCallback });
      const rect2 = (instance as { props: { getReferenceClientRect: () => DOMRect } }).props.getReferenceClientRect();
      assert.ok(rect2, "getReferenceClientRect must never return null after update with null rect");
      assert.strictEqual(rect2.width, 0);

      // onUpdate when cursor rect becomes available
      currentRect = { top: 15, left: 25, bottom: 35, right: 45, width: 20, height: 20, x: 25, y: 15, toJSON: () => ({}) } as unknown as DOMRect;
      renderer.onUpdate({ editor: mockEditor as never, clientRect: clientRectCallback });
      const rect3 = (instance as { props: { getReferenceClientRect: () => DOMRect } }).props.getReferenceClientRect();
      assert.ok(rect3);
      assert.strictEqual(rect3.top, 15);
      assert.strictEqual(rect3.left, 25);

      // Clean exit and unmount
      renderer.onExit();
      assert.strictEqual(instance.state.isDestroyed, true);
      renderer.onExit();

      assert.strictEqual(warnings.length, 0, "No warnings emitted");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("initializes popup on update if clientRect was missing on start", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const renderer = createLinkSuggestionRenderer();

      // onStart with missing clientRect callback
      renderer.onStart({ editor: mockEditor as never, clientRect: null as never });
      assert.strictEqual(bodyElem._tippy, undefined, "Popup not created when clientRect is missing");

      // onUpdate now provides clientRect callback
      const targetRect = { top: 50, left: 60, bottom: 70, right: 80, width: 20, height: 20, x: 60, y: 50, toJSON: () => ({}) } as unknown as DOMRect;
      renderer.onUpdate({ editor: mockEditor as never, clientRect: () => targetRect });

      const instance = bodyElem._tippy;
      assert.ok(instance, "Popup should be initialized on update once clientRect is provided");

      const rect = (instance as { props: { getReferenceClientRect: () => DOMRect } }).props.getReferenceClientRect();
      assert.strictEqual(rect.top, 50);

      renderer.onExit();
      assert.strictEqual(instance.state.isDestroyed, true);
      renderer.onExit();

      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("destroys prior unclosed popup if onStart is called again without onExit", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const renderer = createLinkSuggestionRenderer();

      // Open session 1
      renderer.onStart({ editor: mockEditor as never, clientRect });
      const inst1 = bodyElem._tippy;
      assert.ok(inst1);
      let dest1 = 0;
      const origDest1 = inst1.destroy;
      inst1.destroy = () => {
        dest1++;
        origDest1.call(inst1);
      };

      // Open session 2 without calling onExit first
      renderer.onStart({ editor: mockEditor as never, clientRect });
      assert.strictEqual(dest1, 1, "Lingering session 1 popup must be destroyed when session 2 starts");

      const inst2 = bodyElem._tippy;
      assert.ok(inst2);
      let dest2 = 0;
      const origDest2 = inst2.destroy;
      inst2.destroy = () => {
        dest2++;
        origDest2.call(inst2);
      };

      renderer.onExit();
      assert.strictEqual(dest2, 1, "Session 2 popup must be destroyed on exit");
      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("integrates with ProseMirror plugin view destroy lifecycle without double destroy", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const configured = LinkSuggestion.configure({
        spaceId: "space-int",
        currentDocId: "doc-int",
      });

      const addPlugins = LinkSuggestion.config.addProseMirrorPlugins;
      assert.ok(typeof addPlugins === "function");

      const plugins = addPlugins.call({
        editor: mockEditor as never,
        options: configured.options,
      });

      assert.strictEqual(plugins.length, 1);
      const plugin = plugins[0];
      assert.ok(plugin);

      const viewPlugin = plugin.spec.view(mockEditor.view);
      assert.ok(typeof viewPlugin.destroy === "function");

      // Verify destroy executes cleanly without errors or warnings
      viewPlugin.destroy();
      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });
});
