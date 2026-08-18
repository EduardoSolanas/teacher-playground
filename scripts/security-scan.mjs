#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

function repositoryRootFromArguments(arguments_) {
  const rootIndex = arguments_.indexOf('--root');
  if (rootIndex === -1) {
    return process.cwd();
  }
  if (!arguments_[rootIndex + 1]) {
    throw new Error('--root requires a path');
  }
  return resolve(arguments_[rootIndex + 1]);
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function trackedContent(root, relativePath) {
  try {
    return readFileSync(resolve(root, relativePath));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    return execFileSync('git', ['show', `:${relativePath}`], { cwd: root });
  }
}

function isNonExampleEnvironmentFile(relativePath) {
  const fileName = basename(relativePath);
  return /^\.env(?:\.|$)/.test(fileName) && !fileName.endsWith('.example');
}

function isTrackedDatabase(relativePath) {
  return /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(relativePath);
}

const privateKeyPattern = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const credentialPatterns = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
  /\bgithub_pat_[0-9A-Za-z_]{20,255}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/,
  /\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}\b/,
  /\b(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CLOUDFLARE_ACCESS_CLIENT_SECRET|CLOUDFLARE_CLIENT_SECRET|CF_API_TOKEN|CF_API_KEY|CF_ACCESS_CLIENT_SECRET|OPENAI_API_KEY|GOOGLE_CLIENT_SECRET|FACEBOOK_APP_SECRET)\s*[:=]\s*["']?[0-9A-Za-z._~+/-]{20,}/,
];
const emailPattern = /[A-Z0-9][A-Z0-9.!#$%&'*+/=?^_`{|}~-]{0,63}@((?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63})/gi;
const reservedEmailDomains = new Set(['example.com', 'example.net', 'example.org']);

function isReservedEmailDomain(domain) {
  const normalized = domain.toLowerCase();
  if (
    reservedEmailDomains.has(normalized) ||
    normalized.endsWith('.example') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.invalid') ||
    normalized.endsWith('.localhost')
  ) {
    return true;
  }
  for (const reserved of reservedEmailDomains) {
    if (normalized.endsWith(`.${reserved}`)) return true;
  }
  return false;
}

function containsNonReservedEmail(text) {
  emailPattern.lastIndex = 0;
  for (const match of text.matchAll(emailPattern)) {
    if (!isReservedEmailDomain(match[1])) {
      return true;
    }
  }
  return false;
}

function addFinding(findings, category, relativePath) {
  findings.add(`${category}: ${relativePath}`);
}

function main() {
  const root = repositoryRootFromArguments(process.argv.slice(2));
  const findings = new Set();
  const files = trackedFiles(root);

  for (const relativePath of files) {
    if (isNonExampleEnvironmentFile(relativePath)) {
      addFinding(findings, 'non-example environment file', relativePath);
    }
    if (isTrackedDatabase(relativePath)) {
      addFinding(findings, 'tracked database file', relativePath);
    }

    const content = trackedContent(root, relativePath);
    const text = content.toString('utf8');
    if (privateKeyPattern.test(text)) {
      addFinding(findings, 'private key material', relativePath);
    }
    if (credentialPatterns.some((pattern) => pattern.test(text))) {
      addFinding(findings, 'known credential token', relativePath);
    }
    if (containsNonReservedEmail(text)) {
      addFinding(findings, 'non-reserved email address', relativePath);
    }
  }

  if (findings.size > 0) {
    console.error('Security scan failed. Matched values are redacted:');
    for (const finding of [...findings].sort()) {
      console.error(`- ${finding}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Security scan passed (${files.length} tracked files inspected).`);
}

try {
  main();
} catch (error) {
  console.error(`Security scan could not run: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 2;
}
