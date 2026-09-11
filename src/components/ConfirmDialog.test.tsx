import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import ConfirmDialog from './ConfirmDialog';

function renderDialog() {
  return render(
    <ConfirmDialog
      isOpen={true}
      title="Clear Board"
      body="This will remove all elements for all users. Are you sure?"
      confirmLabel="Clear Board"
      testIdPrefix="whiteboard-clear"
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
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
});
