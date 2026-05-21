import type { CanvasElement } from '@/types/whiteboard';

export class HistoryManager {
  private past: CanvasElement[][] = [];
  private future: CanvasElement[][] = [];
  public maxSize = 50;

  // Records that we've reached a new state
  push(newState: CanvasElement[]) {
    this.past.push(JSON.parse(JSON.stringify(newState)));
    if (this.past.length > this.maxSize) {
      this.past.shift();
    }
    this.future = [];
  }

  // undo: returns the state we're going back to (or [] if at the beginning)
  undo(): CanvasElement[] | null {
    if (this.past.length === 0) return null;
    // Save current state for redo
    const currentState = this.past.pop()!;
    this.future.push(JSON.parse(JSON.stringify(currentState)));
    // Return the previous state, or [] if there is none
    if (this.past.length === 0) return [];
    return this.past[this.past.length - 1];
  }

  // redo: returns to the state we just undid to
  redo(): CanvasElement[] | null {
    if (this.future.length === 0) return null;
    const next = this.future.pop()!;
    this.past.push(JSON.parse(JSON.stringify(next)));
    return next;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }
}
