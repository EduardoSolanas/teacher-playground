#!/usr/bin/env node
/**
 * Operator CLI for the D11 surface (O-1 invoice approval, O-2 dispute review).
 *
 * Reads the teacher host base URL and a Cloudflare Access assertion from
 * OPERATOR_BASE_URL / OPERATOR_ACCESS_TOKEN, POSTs the operator action, and
 * prints the audited server result. It embeds no secrets and writes nothing
 * locally: every action is authorized, recorded, and audited server-side.
 */
import { pathToFileURL } from 'node:url';

const APPROVE_PATH = '/api/company/operator/invoice-approval';
const REVIEW_PATH = '/api/company/operator/disputes/review';
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const USAGE = `Usage:
  operator.mjs approve-invoice --company <companyId> --seats <count> [--operation-id <id>]
  operator.mjs review-dispute --dispute <disputeId> --outcome won|lost [--operation-id <id>]

Environment:
  OPERATOR_BASE_URL      teacher host base URL, e.g. https://app.example.com
  OPERATOR_ACCESS_TOKEN  Cloudflare Access assertion for an allowlisted operator
`;

function fail(log, message) {
  log.error(`operator: ${message}`);
  return 2;
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) return { error: `unexpected argument '${flag}'` };
    const name = flag.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { error: `missing value for ${flag}` };
    }
    flags[name] = value;
    index += 1;
  }
  return { flags };
}

export function buildOperatorRequest(input) {
  const { flags, baseUrl } = input;
  const operationId = flags['operation-id'] ?? crypto.randomUUID();
  if (!OPERATION_ID_RE.test(operationId)) {
    return { error: 'operation id must match [A-Za-z0-9_-]{1,128}' };
  }

  if (input.action === 'approve-invoice') {
    const companyId = flags.company;
    const seats = Number(flags.seats);
    if (typeof companyId !== 'string' || companyId.length < 1 || companyId.length > 128) {
      return { error: '--company is required' };
    }
    if (!Number.isInteger(seats) || seats < 1 || seats > 10_000) {
      return { error: '--seats must be an integer between 1 and 10000' };
    }
    return {
      url: `${baseUrl}${APPROVE_PATH}`,
      body: { companyId, quantity: seats, operationId },
      operationId,
    };
  }

  if (input.action === 'review-dispute') {
    const disputeId = flags.dispute;
    const outcome = flags.outcome;
    if (typeof disputeId !== 'string' || disputeId.length < 1 || disputeId.length > 255) {
      return { error: '--dispute is required' };
    }
    if (outcome !== 'won' && outcome !== 'lost') {
      return { error: '--outcome must be won or lost' };
    }
    return {
      url: `${baseUrl}${REVIEW_PATH}`,
      body: { disputeId, outcome, operationId },
      operationId,
    };
  }

  return { error: `unknown action '${input.action}'` };
}

export function resolveOperatorEnvironment(env, log) {
  const baseUrl = env.OPERATOR_BASE_URL;
  const token = env.OPERATOR_ACCESS_TOKEN;
  const missing = [];
  if (!baseUrl) missing.push('OPERATOR_BASE_URL is required');
  if (!token) missing.push('OPERATOR_ACCESS_TOKEN is required');
  if (missing.length > 0) {
    for (const message of missing) log.error(`operator: ${message}`);
    return { error: 2 };
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { error: fail(log, 'OPERATOR_BASE_URL must be a valid URL') };
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return { error: fail(log, 'OPERATOR_BASE_URL must use https') };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error: fail(log, 'OPERATOR_BASE_URL must be a bare origin') };
  }
  return { baseUrl: parsed.origin, token };
}

export async function main(
  argv,
  env,
  fetchImpl = globalThis.fetch,
  log = console,
) {
  const action = argv[0];
  if (action === undefined || action === '--help' || action === '-h') {
    log.error(USAGE);
    return action === undefined ? 2 : 0;
  }
  const resolved = resolveOperatorEnvironment(env, log);
  if (resolved.error !== undefined) return resolved.error;

  const parsedFlags = parseFlags(argv.slice(1));
  if (parsedFlags.error !== undefined) return fail(log, parsedFlags.error);

  const request = buildOperatorRequest({
    action,
    flags: parsedFlags.flags,
    baseUrl: resolved.baseUrl,
    token: resolved.token,
  });
  if (request.error !== undefined) return fail(log, request.error);

  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-access-jwt-assertion': resolved.token,
        origin: resolved.baseUrl,
      },
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    log.error(`operator: request failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    log.error(`operator: action failed (${response.status}): ${JSON.stringify(body)}`);
    return 1;
  }

  log.log(JSON.stringify(body, null, 2));
  return 0;
}

const entry = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href;
if (import.meta.url === entry) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error('operator:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
