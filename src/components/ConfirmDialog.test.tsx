import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import ConfirmDialog, { useDialogFocusTrap } from './ConfirmDialog';

function renderDialog(
  props: Partial<{
    isOpen: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    cancelLabel: string;
    testIdPrefix: string;
  }> = {},
) {
  const testIdPrefix = props.testIdPrefix ?? 'whiteboard-clear';
  return render(
    <ConfirmDialog
      isOpen={props.isOpen ?? true}
      title="Clear Board"
      body="This will remove all elements for all users. Are you sure?"
      confirmLabel="Clear Board"
      testIdPrefix={testIdPrefix}
      onConfirm={props.onConfirm ?? (() => undefined)}
      onCancel={props.onCancel ?? (() => undefined)}
      cancelLabel={props.cancelLabel}
    />,
  );
}

function ControlHarness({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      isOpen={open}
      title="Clear Board"
      body="Body"
      confirmLabel="Clear"
      testIdPrefix="harness"
      onConfirm={() => {
        onConfirm();
        setOpen(false);
      }}
      onCancel={() => {
        onCancel();
        setOpen(false);
      }}
    />
  );
}

function TrapProbe({ initial = false, empty = false }: { initial?: boolean; empty?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialRef = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(dialogRef, initial ? initialRef : undefined);
  return (
    <div ref={dialogRef} data-testid="trap-dialog">
      {initial && <button ref={initialRef}>initial</button>}
      {!empty && <button>first</button>}
      {!empty && <button>last</button>}
      {empty && <p>no focusable content</p>}
    </div>
  );
}

function ConditionalTrapProbe({ show }: { show: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialRef = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(dialogRef, initialRef);
  return show ? (
    <div ref={dialogRef}>
      <button ref={initialRef}>inside</button>
    </div>
  ) : null;
}

describe('ConfirmDialog', () => {
  it('paints above every layer of room chrome', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: /clear board/i });

    // Nav 1300, call panel 1400, ambient notices 1450/1500.
    expect(dialog.parentElement?.className).toContain('z-[1600]');
  });

  it('uses the documented modal recipe: white rounded-xl card, p-8, shadow-xl', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: /clear board/i });
    const className = dialog.className;
    expect(className).toContain('bg-white');
    expect(className).toContain('rounded-xl');
    expect(className).toContain('p-8');
    expect(className).toContain('shadow-xl');
  });

  it('defaults the cancel label to Cancel and honours an override', () => {
    const { unmount } = renderDialog({ testIdPrefix: 'first' });
    expect(screen.getByTestId('first-cancel-btn').textContent).toBe('Cancel');
    unmount();

    renderDialog({ cancelLabel: 'Keep it', testIdPrefix: 'second' });
    expect(screen.getByTestId('second-cancel-btn').textContent).toBe('Keep it');
  });

  it('renders nothing and ignores keys while closed', () => {
    const calls: string[] = [];
    renderDialog({
      isOpen: false,
      onCancel: () => calls.push('cancel'),
      onConfirm: () => calls.push('confirm'),
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(calls).toEqual([]);
  });

  it('cancels on Escape and ignores other keys', () => {
    const calls: string[] = [];
    renderDialog({ onCancel: () => calls.push('cancel') });

    fireEvent.keyDown(document, { key: 'a' });
    expect(calls).toEqual([]);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(calls).toEqual(['cancel']);
  });

  it('starts focus on the safe action and wraps Tab in both directions', () => {
    renderDialog();

    const cancel = screen.getByTestId('whiteboard-clear-cancel-btn');
    const confirm = screen.getByTestId('whiteboard-clear-confirm-btn');
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
  });

  it('leaves Tab alone when focus is on neither edge control', () => {
    renderDialog();

    const cancel = screen.getByTestId('whiteboard-clear-cancel-btn');
    const confirm = screen.getByTestId('whiteboard-clear-confirm-btn');

    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('cancels on a backdrop click but not on a click inside the dialog', () => {    const calls: string[] = [];
    renderDialog({ onCancel: () => calls.push('cancel') });

    const dialog = screen.getByRole('dialog', { name: /clear board/i });
    fireEvent.click(dialog);
    expect(calls).toEqual([]);

    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(calls).toEqual(['cancel']);
  });

  it('restores focus to the opener when it closes', () => {
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    const { rerender } = render(
      <ConfirmDialog
        isOpen
        title="Clear Board"
        body="Body"
        confirmLabel="Clear"
        testIdPrefix="restore"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(screen.getByTestId('restore-cancel-btn'));

    rerender(
      <ConfirmDialog
        isOpen={false}
        title="Clear Board"
        body="Body"
        confirmLabel="Clear"
        testIdPrefix="restore"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('closes through the real controls', () => {
    const calls: string[] = [];
    render(<ControlHarness onCancel={() => calls.push('cancel')} onConfirm={() => calls.push('confirm')} />);

    fireEvent.click(screen.getByTestId('harness-confirm-btn'));
    expect(calls).toEqual(['confirm']);
    expect(screen.queryByTestId('harness-confirm-btn')).toBeNull();
  });
});

describe('useDialogFocusTrap', () => {
  it('focuses the first focusable when no initial target is given', () => {
    render(<TrapProbe />);

    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('focuses the initial target when one is given', () => {
    render(<TrapProbe initial />);

    expect(document.activeElement).toBe(screen.getByText('initial'));
  });

  it('does not try to restore focus to a previous holder that is not an HTMLElement', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('tabindex', '0');
    document.body.appendChild(svg);
    svg.focus();
    expect(document.activeElement).toBe(svg);

    const { unmount } = render(<TrapProbe />);
    expect(document.activeElement).toBe(screen.getByText('first'));

    unmount();
    expect(document.activeElement).toBe(document.body);
    svg.remove();
  });

  it('restores the previously focused element when the trap unmounts', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(<TrapProbe />);
    expect(document.activeElement).toBe(screen.getByText('first'));

    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('wraps Tab from the last focusable back to the first', () => {
    render(<TrapProbe />);

    screen.getByText('last').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    render(<TrapProbe />);

    screen.getByText('first').focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('last'));
  });

  it('leaves Tab alone when focus is on neither end of the trap', () => {
    render(<TrapProbe />);

    const first = screen.getByText('first');
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('pulls focus back into the dialog when Tab is pressed outside it', () => {
    render(<TrapProbe />);

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('last'));
  });

  it('ignores Tab when the dialog has no focusable content', () => {
    render(<TrapProbe empty />);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(document.body);
  });

  it('ignores keys that are not Tab', () => {
    render(<TrapProbe />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('ignores Tab when the dialog element is no longer mounted', () => {
    const { rerender } = render(<ConditionalTrapProbe show />);
    expect(document.activeElement).toBe(screen.getByText('inside'));

    rerender(<ConditionalTrapProbe show={false} />);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(document.body);
  });
});
