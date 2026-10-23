import { describe, expect, it } from 'vitest';
import { SERVER_NAME } from './index.js';

describe('mcp', () => {
  it('exports its server name', () => {
    expect(SERVER_NAME).toBe('dnd-mcp');
  });
});
