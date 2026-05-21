import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';

// Mock y-webrtc - WebrtcProvider is a class that needs to be a constructor
const mockProviderInstance = {
  on: vi.fn(),
  off: vi.fn(),
  destroy: vi.fn(),
  emit: vi.fn(),
};

function MockWebrtcProvider(this: any, _opts: any) {
  return mockProviderInstance;
}

vi.mock('y-webrtc', () => ({
  WebrtcProvider: MockWebrtcProvider,
}));

// Mock localStorage
const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage[key] = value;
  }),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
});

import { createCollaboration } from './collaboration';

describe('collaboration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderInstance.on.mockReset();
    mockProviderInstance.destroy.mockReset();
  });

  it('initializes collaboration layer', () => {
    const collab = createCollaboration('test-room-init');
    expect(collab.doc).toBeInstanceOf(Y.Doc);
    expect(collab.elementsArray).toBeInstanceOf(Y.Array);
    expect(collab.cursorsMap).toBeInstanceOf(Y.Map);
    expect(collab.provider).toBeDefined();
    expect(collab.localPeerId).toBeDefined();
    expect(typeof collab.localPeerId).toBe('string');
    expect(collab.setLocalCursor).toBeDefined();
    expect(collab.setLocalUserName).toBeDefined();
    expect(collab.getUsers).toBeDefined();
    expect(collab.getElements).toBeDefined();
    expect(collab.addElement).toBeDefined();
    expect(collab.removeElement).toBeDefined();
    expect(collab.updateElement).toBeDefined();
    expect(collab.onChange).toBeDefined();
    expect(collab.destroy).toBeDefined();
    collab.destroy();
  });

  it('sets local cursor', () => {
    const collab = createCollaboration('test-room-cursor');
    collab.setLocalCursor(100, 200);
    const users = collab.getUsers();
    expect(users).toHaveLength(1);
    expect(users[0].userName).toBe('Anonymous');
    collab.destroy();
  });

  it('sets local user name', () => {
    const collab = createCollaboration('test-room-name');
    collab.setLocalUserName('TestUser');
    collab.setLocalCursor(50, 50);
    const users = collab.getUsers();
    expect(users).toHaveLength(1);
    expect(users[0].userName).toBe('TestUser');
    collab.destroy();
  });

  it('adds element to collaboration', () => {
    const collab = createCollaboration('test-room-add');
    collab.addElement({
      id: 'el-1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: '#ff0000',
      stroke: '#000000',
      strokeWidth: 2,
    });
    const elements = collab.getElements();
    expect(elements).toHaveLength(1);
    expect(elements[0].id).toBe('el-1');
    collab.destroy();
  });

  it('removes element from collaboration', () => {
    const collab = createCollaboration('test-room-remove');
    collab.addElement({
      id: 'el-1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: '#ff0000',
      stroke: '#000000',
      strokeWidth: 2,
    });
    expect(collab.getElements()).toHaveLength(1);
    collab.removeElement('el-1');
    expect(collab.getElements()).toHaveLength(0);
    collab.destroy();
  });

  it('updates element in collaboration', () => {
    const collab = createCollaboration('test-room-update');
    collab.addElement({
      id: 'el-1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: '#ff0000',
      stroke: '#000000',
      strokeWidth: 2,
    });
    collab.updateElement('el-1', { fill: '#00ff00' } as any);
    const elements = collab.getElements();
    expect((elements[0] as any).fill).toBe('#00ff00');
    collab.destroy();
  });

  it('handles yjs sync with provider', () => {
    const collab = createCollaboration('test-room-sync');
    let syncedElements: any[] = [];

    collab.onChange((type, data) => {
      if (type === 'elements') {
        syncedElements = data;
      }
    });

    collab.addElement({
      id: 'el-sync-1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000000',
      strokeWidth: 2,
    });

    // The change callback should fire on doc update
    expect(syncedElements.length).toBeGreaterThan(0);
    collab.destroy();
  });
});
