import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('shared', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@dnd/shared');
  });
});
