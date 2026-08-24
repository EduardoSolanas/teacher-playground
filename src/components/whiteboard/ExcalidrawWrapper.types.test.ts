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
});
