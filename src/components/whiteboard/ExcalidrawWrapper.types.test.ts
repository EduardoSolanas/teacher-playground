import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

const wrapperPath = join(import.meta.dirname, 'ExcalidrawWrapper.tsx');

describe('ExcalidrawWrapper type boundary', () => {
  it('does not use explicit any at the Excalidraw boundary', () => {
    const source = readFileSync(wrapperPath, 'utf8');

    const sourceFile = ts.createSourceFile(
      wrapperPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const explicitAnyNodes: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) explicitAnyNodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(explicitAnyNodes, 'explicit any type nodes').toHaveLength(0);
  });

  it('fills the room shell instead of flooring its own height', () => {
    // min-h-[25rem] inside a `calc(100dvh - ...)` overflow-hidden shell clips
    // the bottom of the board -- and with it the toolbar, zoom and footer --
    // on short or landscape viewports. The shell owns the height.
    const source = readFileSync(wrapperPath, 'utf8');
    expect(source).not.toContain('min-h-[25rem]');
    expect(source).toContain('h-full min-h-0');
  });

  it('renders Excalidraw chrome in the same language as the document', () => {
    const source = readFileSync(wrapperPath, 'utf8');
    expect(source).toMatch(/langCode="en"/);
  });
});
