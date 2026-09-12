import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = resolve(process.cwd(), 'scripts/operator.mjs');

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function startOperatorServer(
  status: number,
  responseBody: unknown,
): Promise<{ server: Server; base: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: raw.length > 0 ? (JSON.parse(raw) as unknown) : null,
      });
      response.setHeader('content-type', 'application/json');
      response.statusCode = status;
      response.end(JSON.stringify(responseBody));
    });
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('operator test server did not bind'));
        return;
      }
      resolveServer({
        server,
        base: `http://127.0.0.1:${address.port}`,
        requests,
      });
    });
  });
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    ),
  );
});

interface OperatorRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runOperator(
  args: string[],
  env: Record<string, string>,
): Promise<OperatorRun> {
  const base = { ...process.env };
  delete base.OPERATOR_BASE_URL;
  delete base.OPERATOR_ACCESS_TOKEN;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...base, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('operator CLI', () => {
  it('refuses to run without the base URL and Access token', async () => {
    const result = await runOperator(
      ['approve-invoice', '--company', 'co_1', '--seats', '12'],
      {},
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('OPERATOR_BASE_URL');
    expect(result.stderr).toContain('OPERATOR_ACCESS_TOKEN');
    expect(result.stdout).not.toContain('sk_');
  });

  it('posts the approval through the operator surface and prints the audited result', async () => {
    const { server, base, requests } = await startOperatorServer(202, {
      status: 'pending',
      operationId: 'server-sees-this',
    });
    servers.push(server);

    const result = await runOperator(
      ['approve-invoice', '--company', 'co_42', '--seats', '12'],
      {
        OPERATOR_BASE_URL: base,
        OPERATOR_ACCESS_TOKEN: 'operator-access-token',
      },
    );

    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    const recorded = requests[0];
    expect(recorded.method).toBe('POST');
    expect(recorded.url).toBe('/api/company/operator/invoice-approval');
    expect(recorded.headers['cf-access-jwt-assertion']).toBe('operator-access-token');
    expect(recorded.headers.origin).toBe(base);
    expect(recorded.body).toEqual({
      companyId: 'co_42',
      quantity: 12,
      operationId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
    });
    const printed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(printed).toEqual({ status: 'pending', operationId: 'server-sees-this' });
    expect(result.stdout).not.toContain('operator-access-token');
  });

  it('posts a dispute review with the chosen outcome and never embeds the token', async () => {
    const { server, base, requests } = await startOperatorServer(200, {
      outcome: 'resolved',
      disputeId: 'dp_1',
      state: 'won',
    });
    servers.push(server);

    const result = await runOperator(
      [
        'review-dispute',
        '--dispute',
        'dp_1',
        '--outcome',
        'won',
        '--operation-id',
        'op_cli_review',
      ],
      {
        OPERATOR_BASE_URL: base,
        OPERATOR_ACCESS_TOKEN: 'operator-access-token',
      },
    );

    expect(result.code).toBe(0);
    expect(requests[0].url).toBe('/api/company/operator/disputes/review');
    expect(requests[0].body).toEqual({
      disputeId: 'dp_1',
      outcome: 'won',
      operationId: 'op_cli_review',
    });
    expect(result.stdout).toContain('"outcome": "resolved"');
  });

  it('reports a refusal without inventing success', async () => {
    const { server, base } = await startOperatorServer(403, { error: 'Forbidden' });
    servers.push(server);

    const result = await runOperator(
      ['approve-invoice', '--company', 'co_42', '--seats', '12'],
      { OPERATOR_BASE_URL: base, OPERATOR_ACCESS_TOKEN: 'operator-access-token' },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('403');
    expect(result.stdout).not.toContain('"status"');
  });
});
