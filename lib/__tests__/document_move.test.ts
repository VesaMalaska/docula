import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateNewPath,
  calculateDescendantPath,
  calculateSubtreeHeightFromPaths,
  calculateDeletedDocumentSubtreeHeight,
  getNodeDepth,
  getSubtreeHeight,
  validateMoveDestination,
  validateRestorationDestination,
  isDepthAllowed,
  MAX_DOCUMENT_DEPTH,
  getVisibleTreeItems,
  findNextVisibleId,
  findPreviousVisibleId,
  findParentVisibleId,
  findFirstChildVisibleId,
  resolveVisibleActiveId,
  SPACE_ROOT_ID,
} from '../utils/hierarchy.ts';
import type { SidebarNode } from '../types.ts';

describe('Document Move Path Calculations', () => {
  describe('calculateNewPath', () => {
    test('returns empty array when moving to root', () => {
      assert.deepEqual(calculateNewPath(['A', 'B'], null), []);
    });

    test('returns parent path + parent id when moving to a child', () => {
      assert.deepEqual(calculateNewPath(['A', 'B'], 'C'), ['A', 'B', 'C']);
    });

    test('returns just parent id when parent is root', () => {
      assert.deepEqual(calculateNewPath([], 'A'), ['A']);
      assert.deepEqual(calculateNewPath(undefined, 'A'), ['A']);
    });
  });

  describe('calculateDescendantPath', () => {
    test('returns unchanged path if targetId is not found', () => {
      assert.deepEqual(calculateDescendantPath(['A', 'B'], 'X', ['C']), ['A', 'B']);
    });

    test('updates prefix for a direct child', () => {
      assert.deepEqual(calculateDescendantPath(['X'], 'X', []), ['X']);
    });

    test('updates prefix for a deep descendant', () => {
      assert.deepEqual(calculateDescendantPath(['A', 'B', 'X', 'C', 'E'], 'X', ['Y']), ['Y', 'X', 'C', 'E']);
    });

    test('handles multiple ancestors properly', () => {
      assert.deepEqual(calculateDescendantPath(['X', 'A', 'B'], 'X', ['Z', 'W']), ['Z', 'W', 'X', 'A', 'B']);
    });
  });
});

describe('Document Hierarchy & Four-Level Depth Validation', () => {
  // Fixture tree covering 4 document levels and duplicate titles
  const sampleTree: SidebarNode[] = [
    {
      id: 'doc-1',
      title: 'Architecture',
      parentId: null,
      children: [
        {
          id: 'doc-1-1',
          title: 'Components',
          parentId: 'doc-1',
          children: [
            {
              id: 'doc-1-1-1',
              title: 'Button',
              parentId: 'doc-1-1',
              children: [
                {
                  id: 'doc-1-1-1-1',
                  title: 'Icon',
                  parentId: 'doc-1-1-1',
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'doc-2',
      title: 'Guides',
      parentId: null,
      children: [
        {
          id: 'doc-2-1',
          title: 'Setup',
          parentId: 'doc-2',
          children: [
            {
              id: 'doc-2-1-1',
              title: 'Installation',
              parentId: 'doc-2-1',
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: 'doc-3',
      title: 'Guides', // Duplicate document name to verify ID-based resolution
      parentId: null,
      children: [
        {
          id: 'doc-3-1',
          title: 'Overview',
          parentId: 'doc-3',
          children: [],
        },
      ],
    },
  ];

  describe('document depth for root and nested documents', () => {
    test('Space root has depth 0', () => {
      assert.equal(getNodeDepth(sampleTree, null), 0);
    });

    test('root-level documents have depth 1', () => {
      assert.equal(getNodeDepth(sampleTree, 'doc-1'), 1);
      assert.equal(getNodeDepth(sampleTree, 'doc-2'), 1);
      assert.equal(getNodeDepth(sampleTree, 'doc-3'), 1);
    });

    test('child documents have depth 2', () => {
      assert.equal(getNodeDepth(sampleTree, 'doc-1-1'), 2);
      assert.equal(getNodeDepth(sampleTree, 'doc-2-1'), 2);
      assert.equal(getNodeDepth(sampleTree, 'doc-3-1'), 2);
    });

    test('grandchild documents have depth 3', () => {
      assert.equal(getNodeDepth(sampleTree, 'doc-1-1-1'), 3);
      assert.equal(getNodeDepth(sampleTree, 'doc-2-1-1'), 3);
    });

    test('great-grandchild documents have depth 4', () => {
      assert.equal(getNodeDepth(sampleTree, 'doc-1-1-1-1'), 4);
    });

    test('returns -1 for unknown document ID', () => {
      assert.equal(getNodeDepth(sampleTree, 'nonexistent-doc'), -1);
    });
  });

  describe('subtree height for a leaf and nested subtree', () => {
    test('leaf document has height 1', () => {
      const leafNode = sampleTree[0].children[0].children[0].children[0];
      assert.equal(leafNode.id, 'doc-1-1-1-1');
      assert.equal(getSubtreeHeight(leafNode), 1);
    });

    test('document with 1 descendant level has height 2', () => {
      const level3Node = sampleTree[0].children[0].children[0];
      assert.equal(level3Node.id, 'doc-1-1-1');
      assert.equal(getSubtreeHeight(level3Node), 2);
    });

    test('document with 2 descendant levels has height 3', () => {
      const level2Node = sampleTree[0].children[0];
      assert.equal(level2Node.id, 'doc-1-1');
      assert.equal(getSubtreeHeight(level2Node), 3);
    });

    test('document with 3 descendant levels has height 4', () => {
      const rootNode = sampleTree[0];
      assert.equal(rootNode.id, 'doc-1');
      assert.equal(getSubtreeHeight(rootNode), 4);
    });

    test('calculateSubtreeHeightFromPaths returns 1 for leaf with no descendants', () => {
      assert.equal(calculateSubtreeHeightFromPaths('target', []), 1);
    });

    test('calculateSubtreeHeightFromPaths correctly calculates height for multi-level descendants', () => {
      const paths = [
        ['doc-1'],
        ['doc-1', 'child-1'],
        ['doc-1', 'child-1', 'grandchild-1'],
      ];
      assert.equal(calculateSubtreeHeightFromPaths('doc-1', paths), 4);
      assert.equal(calculateSubtreeHeightFromPaths('child-1', paths), 3);
    });
  });

  describe('move destination validation rules', () => {
    test('valid move reaching exactly level four: leaf moved beneath level 3 document (3 + 1 = 4)', () => {
      // doc-3-1 is a leaf (height 1). Moving beneath doc-2-1-1 (depth 3): 3 + 1 = 4 <= 4
      const result = validateMoveDestination(sampleTree, 'doc-3-1', 'doc-2-1-1', 'doc-3');
      assert.deepEqual(result, { valid: true });
    });

    test('valid move reaching exactly level four: 2-level subtree moved beneath level 2 document (2 + 2 = 4)', () => {
      // doc-2-1 has height 2 (contains doc-2-1-1). Moving beneath doc-3-1 (depth 2): 2 + 2 = 4 <= 4
      const result = validateMoveDestination(sampleTree, 'doc-2-1', 'doc-3-1', 'doc-2');
      assert.deepEqual(result, { valid: true });
    });

    test('valid move reaching exactly level four: 3-level subtree moved beneath level 1 document (1 + 3 = 4)', () => {
      // doc-1-1 has height 3 (contains doc-1-1-1 and doc-1-1-1-1). Moving beneath doc-2 (depth 1): 1 + 3 = 4 <= 4
      const result = validateMoveDestination(sampleTree, 'doc-1-1', 'doc-2', 'doc-1');
      assert.deepEqual(result, { valid: true });
    });

    test('valid move reaching exactly level four: 4-level subtree moved to Space root (0 + 4 = 4)', () => {
      // Fixture with an actual height-4 moved subtree whose current parent is 'parent-doc' (not Space root):
      // parent-doc (depth 1)
      //   └── sub-root (current parent: 'parent-doc', subtree height: 4)
      //         └── sub-level-2
      //               └── sub-level-3
      //                     └── sub-level-4
      const fixtureTree: SidebarNode[] = [
        {
          id: 'parent-doc',
          title: 'Parent',
          parentId: null,
          children: [
            {
              id: 'sub-root',
              title: 'Subtree Root',
              parentId: 'parent-doc',
              children: [
                {
                  id: 'sub-level-2',
                  title: 'Level 2',
                  parentId: 'sub-root',
                  children: [
                    {
                      id: 'sub-level-3',
                      title: 'Level 3',
                      parentId: 'sub-level-2',
                      children: [
                        {
                          id: 'sub-level-4',
                          title: 'Level 4',
                          parentId: 'sub-level-3',
                          children: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];

      const movedNode = fixtureTree[0].children[0];
      assert.equal(getSubtreeHeight(movedNode), 4);
      assert.notEqual(movedNode.parentId, null);

      const result = validateMoveDestination(fixtureTree, 'sub-root', null, 'parent-doc');
      assert.deepEqual(result, { valid: true });
    });

    test('invalid move reaching level five: leaf moved beneath level 4 document (4 + 1 = 5)', () => {
      // doc-3-1 is a leaf (height 1). Moving beneath doc-1-1-1-1 (depth 4): 4 + 1 = 5 > 4
      const result = validateMoveDestination(sampleTree, 'doc-3-1', 'doc-1-1-1-1', 'doc-3');
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'max_depth');
    });

    test('invalid move reaching level five: 2-level subtree moved beneath level 3 document (3 + 2 = 5)', () => {
      // doc-2-1 has height 2. Moving beneath doc-1-1-1 (depth 3): 3 + 2 = 5 > 4
      const result = validateMoveDestination(sampleTree, 'doc-2-1', 'doc-1-1-1', 'doc-2');
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'max_depth');
    });

    test('deep moved subtree rejected under an otherwise shallow-looking destination', () => {
      // doc-1-1 has height 3. doc-2-1 is only at level 2 (shallow). 2 + 3 = 5 > 4
      const result = validateMoveDestination(sampleTree, 'doc-1-1', 'doc-2-1', 'doc-1');
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'max_depth');
    });

    test('Space-root destination uses depth 0 and accepts any valid subtree <= 4', () => {
      // Moving doc-2-1 (height 2) from doc-2 to Space root (depth 0): 0 + 2 = 2 <= 4
      const result = validateMoveDestination(sampleTree, 'doc-2-1', null, 'doc-2');
      assert.deepEqual(result, { valid: true });
    });

    test('self destination is rejected', () => {
      const result = validateMoveDestination(sampleTree, 'doc-1', 'doc-1', null);
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'self');
    });

    test('descendant destination is rejected for direct child', () => {
      const result = validateMoveDestination(sampleTree, 'doc-1', 'doc-1-1', null);
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'descendant');
    });

    test('descendant destination is rejected for deep descendant', () => {
      const result = validateMoveDestination(sampleTree, 'doc-1', 'doc-1-1-1-1', null);
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'descendant');
    });

    test('existing-parent / no-op destination is rejected for document parent', () => {
      // doc-2-1 is already under doc-2
      const result = validateMoveDestination(sampleTree, 'doc-2-1', 'doc-2', 'doc-2');
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'current_parent');
    });

    test('existing-parent / no-op destination is rejected for Space root', () => {
      // doc-1 is already at Space root (parentId: null)
      const result = validateMoveDestination(sampleTree, 'doc-1', null, null);
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'current_parent');
    });

    test('missing destination is rejected', () => {
      const result = validateMoveDestination(sampleTree, 'doc-1', 'ghost-destination', null);
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'not_found');
    });

    test('missing moved document is rejected', () => {
      const result = validateMoveDestination(sampleTree, 'ghost-moved-doc', 'doc-2', null);
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'not_found');
    });

    test('duplicate document names resolved correctly by ID', () => {
      // doc-2 and doc-3 are both named "Guides".
      // Moving doc-2-1 (current parent: doc-2) to doc-3 is valid because ID differs.
      const resultValid = validateMoveDestination(sampleTree, 'doc-2-1', 'doc-3', 'doc-2');
      assert.deepEqual(resultValid, { valid: true });

      // Moving doc-2-1 to doc-2 is rejected as current_parent.
      const resultInvalid = validateMoveDestination(sampleTree, 'doc-2-1', 'doc-2', 'doc-2');
      assert.equal(resultInvalid.valid, false);
      assert.equal(resultInvalid.reason, 'current_parent');
    });
  });

  describe('restoration destination validation & depth rules', () => {
    // Exact QA reproduction active tree:
    // jukukekkuli (depth 1)
    // └── raikuli (depth 2)
    //     └── kuikkeli (depth 3)
    const qaActiveTree: SidebarNode[] = [
      {
        id: 'jukukekkuli',
        title: 'jukukekkuli',
        parentId: null,
        children: [
          {
            id: 'raikuli',
            title: 'raikuli',
            parentId: 'jukukekkuli',
            children: [
              {
                id: 'kuikkeli',
                title: 'kuikkeli',
                parentId: 'raikuli',
                children: [],
              },
            ],
          },
        ],
      },
    ];

    describe('Three-level Trash subtree (A -> B -> C)', () => {
      const trashDocs = [
        { id: 'doc-A', deletionGroupId: 'grp-abc', path: [] },
        { id: 'doc-B', deletionGroupId: 'grp-abc', path: ['doc-A'] },
        { id: 'doc-C', deletionGroupId: 'grp-abc', path: ['doc-A', 'doc-B'] },
      ];

      test('subtree height is 3: max relative path length + 1', () => {
        const height = calculateDeletedDocumentSubtreeHeight('doc-A', trashDocs);
        assert.equal(height, 3);
      });

      test('Space root is valid (depth 0 + height 3 = 3 <= 4)', () => {
        const result = validateRestorationDestination(qaActiveTree, null, 3);
        assert.deepEqual(result, { valid: true });
      });

      test('root-level document is valid only if resulting deepest depth is at most 4 (depth 1 + height 3 = 4 <= 4)', () => {
        const result = validateRestorationDestination(qaActiveTree, 'jukukekkuli', 3);
        assert.deepEqual(result, { valid: true });
      });

      test('destination at depth two is rejected when 2 + 3 > 4 (raikuli)', () => {
        const result = validateRestorationDestination(qaActiveTree, 'raikuli', 3);
        assert.equal(result.valid, false);
        assert.equal(result.reason, 'max_depth');
        assert.equal(result.description, 'Restoring here would exceed the maximum depth of 4 levels');
      });

      test('kuikkeli at depth three is rejected when 3 + 3 > 4', () => {
        const result = validateRestorationDestination(qaActiveTree, 'kuikkeli', 3);
        assert.equal(result.valid, false);
        assert.equal(result.reason, 'max_depth');
        assert.equal(result.description, 'Restoring here would exceed the maximum depth of 4 levels');
      });
    });

    describe('One-level deleted document (single deleted doc)', () => {
      const singleTrashDoc = [{ id: 'single-doc', path: [] }];

      test('subtree height is 1', () => {
        const height = calculateDeletedDocumentSubtreeHeight('single-doc', singleTrashDoc);
        assert.equal(height, 1);
      });

      test('Space root is valid (0 + 1 = 1 <= 4)', () => {
        const result = validateRestorationDestination(sampleTree, null, 1);
        assert.deepEqual(result, { valid: true });
      });

      test('destinations at depths one, two and three are valid', () => {
        // Depth 1 (doc-1): 1 + 1 = 2 <= 4
        assert.deepEqual(validateRestorationDestination(sampleTree, 'doc-1', 1), { valid: true });
        // Depth 2 (doc-1-1): 2 + 1 = 3 <= 4
        assert.deepEqual(validateRestorationDestination(sampleTree, 'doc-1-1', 1), { valid: true });
        // Depth 3 (doc-1-1-1): 3 + 1 = 4 <= 4
        assert.deepEqual(validateRestorationDestination(sampleTree, 'doc-1-1-1', 1), { valid: true });
      });

      test('destination at depth four is rejected (4 + 1 = 5 > 4)', () => {
        // Depth 4 (doc-1-1-1-1): 4 + 1 = 5 > 4
        const result = validateRestorationDestination(sampleTree, 'doc-1-1-1-1', 1);
        assert.equal(result.valid, false);
        assert.equal(result.reason, 'max_depth');
      });
    });

    describe('Two-level deleted subtree (A -> B)', () => {
      const twoLevelTrash = [
        { id: 'doc-A', deletionGroupId: 'grp-ab', path: [] },
        { id: 'doc-B', deletionGroupId: 'grp-ab', path: ['doc-A'] },
      ];

      test('subtree height is 2', () => {
        const height = calculateDeletedDocumentSubtreeHeight('doc-A', twoLevelTrash);
        assert.equal(height, 2);
      });

      test('destination depth one is valid (1 + 2 = 3 <= 4)', () => {
        const result = validateRestorationDestination(sampleTree, 'doc-1', 2);
        assert.deepEqual(result, { valid: true });
      });

      test('destination depth two is valid (2 + 2 = 4 <= 4)', () => {
        const result = validateRestorationDestination(sampleTree, 'doc-1-1', 2);
        assert.deepEqual(result, { valid: true });
      });

      test('destination depth three is rejected (3 + 2 = 5 > 4)', () => {
        const result = validateRestorationDestination(sampleTree, 'doc-1-1-1', 2);
        assert.equal(result.valid, false);
        assert.equal(result.reason, 'max_depth');
      });
    });

    describe('Shared depth formula and validateMoveDestination options', () => {
      test('MAX_DOCUMENT_DEPTH is 4 and isDepthAllowed enforces D + H <= 4', () => {
        assert.equal(MAX_DOCUMENT_DEPTH, 4);
        assert.equal(isDepthAllowed(0, 4), true);
        assert.equal(isDepthAllowed(1, 3), true);
        assert.equal(isDepthAllowed(2, 2), true);
        assert.equal(isDepthAllowed(3, 1), true);
        assert.equal(isDepthAllowed(2, 3), false);
        assert.equal(isDepthAllowed(3, 2), false);
        assert.equal(isDepthAllowed(4, 1), false);
      });

      test('validateMoveDestination with isRestoration: true does not require movedDoc to exist in tree', () => {
        // 'doc-deleted' is not in qaActiveTree
        const resultValid = validateMoveDestination(qaActiveTree, 'doc-deleted', 'jukukekkuli', null, {
          isRestoration: true,
          subtreeHeight: 3,
        });
        assert.deepEqual(resultValid, { valid: true });

        const resultInvalid = validateMoveDestination(qaActiveTree, 'doc-deleted', 'kuikkeli', null, {
          isRestoration: true,
          subtreeHeight: 3,
        });
        assert.equal(resultInvalid.valid, false);
        assert.equal(resultInvalid.reason, 'max_depth');
      });
    });
  });

  describe('visible-tree flattening with expanded and collapsed nodes', () => {
    test('flattens only root items and Space root when all nodes are collapsed', () => {
      const items = getVisibleTreeItems(sampleTree, new Set());
      const ids = items.map((i) => i.id);
      assert.deepEqual(ids, [SPACE_ROOT_ID, 'doc-1', 'doc-2', 'doc-3']);
      assert.equal(items[0].level, 0);
      assert.equal(items[1].level, 1);
    });

    test('includes children when a parent node is expanded', () => {
      const items = getVisibleTreeItems(sampleTree, new Set(['doc-1']));
      const ids = items.map((i) => i.id);
      assert.deepEqual(ids, [SPACE_ROOT_ID, 'doc-1', 'doc-1-1', 'doc-2', 'doc-3']);
      assert.equal(items[2].level, 2);
    });

    test('includes deep children when multiple nested ancestors are expanded', () => {
      const items = getVisibleTreeItems(sampleTree, new Set(['doc-1', 'doc-1-1', 'doc-1-1-1']));
      const ids = items.map((i) => i.id);
      assert.deepEqual(ids, [
        SPACE_ROOT_ID,
        'doc-1',
        'doc-1-1',
        'doc-1-1-1',
        'doc-1-1-1-1',
        'doc-2',
        'doc-3',
      ]);
    });

    test('omits children of collapsed branches even if grandchildren were previously expanded', () => {
      // doc-1 is collapsed, but doc-1-1 is in the set
      const items = getVisibleTreeItems(sampleTree, new Set(['doc-1-1']));
      const ids = items.map((i) => i.id);
      assert.deepEqual(ids, [SPACE_ROOT_ID, 'doc-1', 'doc-2', 'doc-3']);
    });
  });

  describe('keyboard navigation boundaries and relationships', () => {
    test('findNextVisibleId moves forward and stops at end boundary', () => {
      const items = getVisibleTreeItems(sampleTree, new Set());
      assert.equal(findNextVisibleId(items, SPACE_ROOT_ID), 'doc-1');
      assert.equal(findNextVisibleId(items, 'doc-1'), 'doc-2');
      assert.equal(findNextVisibleId(items, 'doc-2'), 'doc-3');
      assert.equal(findNextVisibleId(items, 'doc-3'), null); // Boundary reached
    });

    test('findPreviousVisibleId moves backward and stops at start boundary', () => {
      const items = getVisibleTreeItems(sampleTree, new Set());
      assert.equal(findPreviousVisibleId(items, 'doc-3'), 'doc-2');
      assert.equal(findPreviousVisibleId(items, 'doc-2'), 'doc-1');
      assert.equal(findPreviousVisibleId(items, 'doc-1'), SPACE_ROOT_ID);
      assert.equal(findPreviousVisibleId(items, SPACE_ROOT_ID), null); // Boundary reached
    });

    test('parent relationships used by Left navigation', () => {
      const items = getVisibleTreeItems(sampleTree, new Set(['doc-1', 'doc-1-1']));
      // Root document parent is Space root
      assert.equal(findParentVisibleId(items, 'doc-1'), SPACE_ROOT_ID);
      // Nested document parent is its parent document
      assert.equal(findParentVisibleId(items, 'doc-1-1'), 'doc-1');
      // Space root has no parent
      assert.equal(findParentVisibleId(items, SPACE_ROOT_ID), null);
    });

    test('first-child relationships used by Right navigation', () => {
      const items = getVisibleTreeItems(sampleTree, new Set(['doc-1']));
      // Space root first child is first root document
      assert.equal(findFirstChildVisibleId(items, SPACE_ROOT_ID), 'doc-1');
      // Expanded node first child is its first child document
      assert.equal(findFirstChildVisibleId(items, 'doc-1'), 'doc-1-1');
      // Collapsed node returns null
      assert.equal(findFirstChildVisibleId(items, 'doc-2'), null);
      // Leaf node returns null
      assert.equal(findFirstChildVisibleId(items, 'doc-1-1'), null);
    });
  });

  describe('active tree item resolution and roving-focus invariant', () => {
    test('active descendant hidden by collapsing its ancestor resolves to collapsing ancestor when provided', () => {
      // doc-1 contains doc-1-1 and doc-1-1-1. When doc-1 is collapsed, doc-1-1-1 is hidden.
      const collapsedItems = getVisibleTreeItems(sampleTree, new Set());
      const resolved = resolveVisibleActiveId(
        collapsedItems,
        'doc-1-1-1', // active descendant now hidden
        null,
        'doc-1' // collapsing ancestor
      );
      assert.equal(resolved, 'doc-1');
    });

    test('active descendant hidden by collapsing its ancestor resolves to Space root when ancestor is not provided', () => {
      const collapsedItems = getVisibleTreeItems(sampleTree, new Set());
      const resolved = resolveVisibleActiveId(
        collapsedItems,
        'doc-1-1-1',
        null
      );
      assert.equal(resolved, SPACE_ROOT_ID);
    });

    test('selected destination hidden by manual collapse falls back to visible default or Space root', () => {
      // User selected doc-2-1-1 (grandchild), but manually collapsed doc-2
      const collapsedItems = getVisibleTreeItems(sampleTree, new Set());
      // preferredId is null, defaultId is hidden selected destination doc-2-1-1
      const resolved = resolveVisibleActiveId(
        collapsedItems,
        null,
        'doc-2-1-1'
      );
      assert.equal(resolved, SPACE_ROOT_ID);
    });

    test('stale override ID no longer present in the tree resolves to visible default target', () => {
      const items = getVisibleTreeItems(sampleTree, new Set());
      const resolved = resolveVisibleActiveId(
        items,
        'deleted-ghost-id',
        'doc-2'
      );
      assert.equal(resolved, 'doc-2');
    });

    test('default active ID not present in visibleItems resolves to Space root', () => {
      // defaultId is 'doc-1-1' which is collapsed and not in visibleItems
      const items = getVisibleTreeItems(sampleTree, new Set());
      const resolved = resolveVisibleActiveId(
        items,
        null,
        'doc-1-1'
      );
      assert.equal(resolved, SPACE_ROOT_ID);
    });

    test('Space root fallback is used when preferred and default targets are both unavailable', () => {
      const items = getVisibleTreeItems(sampleTree, new Set());
      const resolved = resolveVisibleActiveId(
        items,
        'nonexistent-preferred',
        'nonexistent-default'
      );
      assert.equal(resolved, SPACE_ROOT_ID);
    });

    test('guarantees exactly one resolved visible active ID across various tree visibility states', () => {
      const states = [
        new Set<string>(),
        new Set(['doc-1']),
        new Set(['doc-1', 'doc-1-1']),
        new Set(['doc-2']),
      ];

      const testIds = [
        null,
        undefined,
        SPACE_ROOT_ID,
        'doc-1',
        'doc-1-1',
        'doc-1-1-1',
        'doc-2-1',
        'stale-unknown-id',
      ];

      for (const expanded of states) {
        const visibleItems = getVisibleTreeItems(sampleTree, expanded);
        for (const preferred of testIds) {
          for (const fallback of testIds) {
            const activeId = resolveVisibleActiveId(visibleItems, preferred, fallback);
            // Exactly one visible item must match the resolved active ID
            const matches = visibleItems.filter((i) => i.id === activeId);
            assert.equal(
              matches.length,
              1,
              `Expected exactly 1 match in visibleItems for activeId "${activeId}" (preferred: ${preferred}, fallback: ${fallback})`
            );
          }
        }
      }
    });
  });
});
