import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type LockPackage = {
  version?: string;
};

type PackageLock = {
  packages?: Record<string, LockPackage>;
};

const repositoryRoot = resolve(process.cwd());

function readPackageLock(): PackageLock {
  return JSON.parse(readFileSync(resolve(repositoryRoot, 'package-lock.json'), 'utf8')) as PackageLock;
}

function dependencyVersions(lock: PackageLock, dependencyName: string): string[] {
  const packageSuffix = `node_modules/${dependencyName}`;

  return Object.entries(lock.packages ?? {})
    .filter(([packagePath]) => packagePath === packageSuffix || packagePath.endsWith(`/${packageSuffix}`))
    .map(([, packageMetadata]) => packageMetadata.version)
    .filter((version): version is string => version !== undefined);
}

function numericVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  expect(match, `expected a numeric semantic version, received ${version}`).not.toBeNull();
  return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  const firstDifference = left.findIndex((part, index) => part !== right[index]);
  return firstDifference === -1 ? 0 : left[firstDifference] - right[firstDifference];
}

function expectAtLeast(version: string, minimum: [number, number, number], advisory: string): void {
  const isAtLeastMinimum = compareVersions(numericVersion(version), minimum) >= 0;

  expect(isAtLeastMinimum, `${advisory}: ${version} must be at least ${minimum.join('.')}`).toBe(true);
}

function expectOutsideInclusiveRange(
  version: string,
  minimum: [number, number, number],
  maximum: [number, number, number],
  advisory: string,
): void {
  const actual = numericVersion(version);
  const isOutsideRange = compareVersions(actual, minimum) < 0 || compareVersions(actual, maximum) > 0;

  expect(isOutsideRange, `${advisory}: ${version} must not be in ${minimum.join('.')} - ${maximum.join('.')}`).toBe(
    true,
  );
}

describe('development dependency security policy', () => {
  it('pins patched versions for the audited high and critical advisories', () => {
    const lock = readPackageLock();

    for (const version of dependencyVersions(lock, 'brace-expansion')) {
      expectAtLeast(version, [1, 1, 18], 'GHSA-3jxr-9vmj-r5cp / GHSA-mh99-v99m-4gvg / GHSA-rgw5-rvv9-x895');
    }

    for (const version of dependencyVersions(lock, 'vite')) {
      expectOutsideInclusiveRange(version, [8, 0, 0], [8, 0, 15], 'GHSA-v6wh-96g9-6wx3 / GHSA-fx2h-pf6j-xcff');
    }

    for (const version of dependencyVersions(lock, 'shell-quote')) {
      expectAtLeast(version, [1, 8, 5], 'GHSA-w7jw-789q-3m8p / GHSA-395f-4hp3-45gv');
    }
  });
});
