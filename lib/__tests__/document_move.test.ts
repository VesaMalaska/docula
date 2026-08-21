import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNewPath, calculateDescendantPath } from '../utils/hierarchy.ts';

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
