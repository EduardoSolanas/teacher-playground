import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

import type { WhiteboardProvider } from './yWebsocketProvider';

/*
 * Two layers, because neither catches the other's failure.
 *
 * The functions below are never called. They exist so that `npm run typecheck`
 * fails if the event union stops rejecting a misspelled name or the wrong
 * payload: an unused `@ts-expect-error` is itself an error, so a type that goes
 * loose again turns these into compile failures rather than silent passes.
 *
 * The runtime test underneath asserts the same thing from the other side, in
 * the idiom ExcalidrawWrapper.types.test.ts already uses, because a typecheck
 * that nobody runs proves nothing in the unit suite.
 */

export function rejectsMisspelledEventNames(provider: WhiteboardProvider) {
  // @ts-expect-error 'syncd' is not an event this provider emits
  provider.on('syncd', () => {});
  // @ts-expect-error 'statuss' is not an event this provider emits
  provider.on('statuss', () => {});
}

export function rejectsWrongPayloadTypes(provider: WhiteboardProvider) {
  // @ts-expect-error 'synced' carries boolean | { synced: boolean }, never a string
  provider.on('synced', (event: string) => { void event; });
  // @ts-expect-error 'status' carries an object, never a boolean
  provider.on('status', (event: boolean) => { void event; });
}

export function acceptsTheRealEvents(provider: WhiteboardProvider) {
  provider.on('status', (event: { status?: string; connected?: boolean }) => { void event; });
  provider.on('synced', (event: boolean | { synced: boolean }) => { void event; });
  provider.on('connection-close', (event: unknown) => { void event; });
}

export function offIsTypedLikeOn(provider: WhiteboardProvider) {
  const onSynced = (event: boolean | { synced: boolean }) => { void event; };
  provider.off?.('synced', onSynced);
  // @ts-expect-error 'syncd' is not an event this provider emits
  provider.off?.('syncd', onSynced);
}

const providerPath = join(import.meta.dirname, 'yWebsocketProvider.ts');

function firstParameterTypeOf(methodName: string): ts.TypeNode | undefined {
  const source = readFileSync(providerPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    providerPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let found: ts.TypeNode | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node)
      && node.name.text === 'WhiteboardProvider'
    ) {
      for (const member of node.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
        if (name !== methodName) continue;
        if (ts.isMethodSignature(member)) found = member.parameters[0]?.type;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('WhiteboardProvider event typing', () => {
  it.each(['on', 'off'])('takes a named event union for %s, not a bare string', (methodName) => {
    const parameterType = firstParameterTypeOf(methodName);

    expect(parameterType, `${methodName} first parameter type`).toBeDefined();
    expect(
      parameterType!.kind,
      `${methodName} still accepts any string as an event name`,
    ).not.toBe(ts.SyntaxKind.StringKeyword);
  });
});
