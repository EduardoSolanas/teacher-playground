/**
 * D-6 collection executor (spec §3.7 D-6, §7.2). The Worker runs this after a
 * webhook apply that left a subscription with `applied_version <
 * desired_version` and no in-flight marker: it claims the current version
 * through the IdentityDO, sets that exact state in Stripe outside any
 * transaction, and settles the claim with the version it was claimed with so a
 * superseded version can never change `billing_subscriptions` (H4).
 */
import { STRIPE_API_VERSION, type BillingEnv } from './stripeConfig';
import { collectionStateRequest } from './stripeRequest';
import { executeStripeRequest, type StripeExecutionResult } from './stripeClient';
import { decideSeatChangeRecovery } from './seatRecovery';
import type { BillingSubjectKind, DesiredCollection } from '../identity/entitlementWriter';
import type {
  OutboundCompanyCreateOperation,
  OutboundOperation,
  OutboundSeatChangeOperation,
} from './reconcile';

const IDENTITY_OPERATIONS_URL = 'https://identity/billing/operations';
const IDENTITY_SETTLE_URL = 'https://identity/billing/operations/settle';
const IDENTITY_SYSTEM_SETTLE_URL = 'https://identity/billing/settle';

export interface SeatItemUpdateInput {
  companyId: string;
  operationId: string;
  processorSubscriptionId: string;
  itemId: string;
  targetQuantity: number;
  prorationBehavior: 'create_prorations' | 'none';
}

export function seatItemUpdateRequest(
  apiBaseUrl: string,
  secretKey: string,
  input: SeatItemUpdateInput,
): Request {
  const params = new URLSearchParams();
  params.append('items[0][id]', input.itemId);
  params.append('items[0][quantity]', String(input.targetQuantity));
  params.append('proration_behavior', input.prorationBehavior);
  return new Request(`${apiBaseUrl}/v1/subscriptions/${input.processorSubscriptionId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `op:company:${input.companyId}:${input.operationId}`,
    },
    body: params.toString(),
  });
}

export interface CompanyCustomerInput {
  companyId: string;
  operationId: string;
  name: string;
  accountId: string;
}

export function companyCustomerRequest(
  apiBaseUrl: string,
  secretKey: string,
  input: CompanyCustomerInput,
): Request {
  const params = new URLSearchParams();
  params.append('name', input.name);
  params.append('metadata[company_id]', input.companyId);
  params.append('metadata[account_id]', input.accountId);
  return new Request(`${apiBaseUrl}/v1/customers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `op:company:${input.companyId}:${input.operationId}`,
    },
    body: params.toString(),
  });
}

export interface CollectionExecutorDeps {
  identityFetch: (request: Request) => Promise<Response>;
  billing: BillingEnv;
}

export interface CollectionSubject {
  subjectKind: BillingSubjectKind;
  subjectId: string;
}

export interface CollectionClaim {
  processorSubscriptionId: string;
  version: number;
  state: DesiredCollection;
}

export type CollectionSendOutcome =
  | { kind: 'success' }
  | { kind: 'failure'; status: number }
  | { kind: 'unknown'; status: number };

export type CollectionExecutionResult =
  | { action: 'none'; reason: string }
  | { action: 'settled'; status: string }
  | { action: 'unknown'; status: number };

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstSubscriptionItem(json: unknown): Record<string, unknown> | null {
  const items = recordOf(json)?.items;
  if (Array.isArray(items)) return recordOf(items[0]);
  const list = recordOf(items);
  if (list === null || !Array.isArray(list.data)) return null;
  return recordOf(list.data[0]);
}

export function stripeSubscriptionItemId(json: unknown): string | null {
  const first = firstSubscriptionItem(json);
  if (first === null) return null;
  const id = first.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function stripeSubscriptionItemQuantity(json: unknown): number | null {
  const first = firstSubscriptionItem(json);
  if (first === null) return null;
  const quantity = first.quantity;
  return typeof quantity === 'number' && Number.isInteger(quantity) ? quantity : null;
}

function isDesiredCollection(value: unknown): value is DesiredCollection {
  return value === 'active' || value === 'paused' || value === 'canceled';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The IdentityDO apply response names the subject whose collection still
 * needs running. Accept only a bounded account/company handoff.
 */
export function parseCollectionSubject(value: unknown): CollectionSubject | null {
  const collection = recordOf(recordOf(value)?.collection);
  if (collection === null) return null;
  const subjectKind = collection.subjectKind;
  const subjectId = collection.subjectId;
  if (subjectKind !== 'account' && subjectKind !== 'company') return null;
  if (typeof subjectId !== 'string' || subjectId.length === 0) return null;
  return { subjectKind, subjectId };
}

/**
 * Never trust a claim response shape: only a granted claim with a real
 * subscription id, a positive integer version, and a known desired state lets
 * the executor call Stripe.
 */
export function parseCollectionClaim(value: unknown): CollectionClaim | null {
  const claim = recordOf(recordOf(value)?.claim);
  if (claim?.claimed !== true) return null;
  const processorSubscriptionId = claim.processorSubscriptionId;
  const version = claim.inFlightVersion;
  const state = claim.inFlightState;
  if (typeof processorSubscriptionId !== 'string' || processorSubscriptionId.length === 0) {
    return null;
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (!isDesiredCollection(state)) return null;
  return { processorSubscriptionId, version, state };
}

export async function claimCollectionExecution(
  deps: CollectionExecutorDeps,
  subject: CollectionSubject,
  operationId: string,
): Promise<CollectionClaim | null> {
  let response: Response;
  try {
    response = await deps.identityFetch(new Request(IDENTITY_OPERATIONS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectKind: subject.subjectKind,
        subjectId: subject.subjectId,
        operationId,
        kind: 'subscription-collection',
      }),
    }));
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return parseCollectionClaim(await readJson(response));
}

/**
 * A rejection means Stripe never returned an answer for this attempt: treated
 * as a definitive failure so the marker clears and the operator sees the
 * alert. An HTTP 5xx (including the client's 503 timeout) is an unknown
 * outcome: the marker stays and R-1 repairs it after 15 minutes.
 */
export function classifyStripeExecution(
  result: StripeExecutionResult | null,
): CollectionSendOutcome {
  if (result === null) return { kind: 'failure', status: 0 };
  if (result.ok) return { kind: 'success' };
  return result.status >= 500
    ? { kind: 'unknown', status: result.status }
    : { kind: 'failure', status: result.status };
}

export async function sendCollectionState(
  deps: CollectionExecutorDeps,
  claim: CollectionClaim,
): Promise<CollectionSendOutcome> {
  const secretKey = deps.billing.secretKey;
  if (secretKey === null) return { kind: 'failure', status: 0 };
  try {
    const result = await executeStripeRequest(
      collectionStateRequest(
        deps.billing.apiBaseUrl,
        secretKey,
        claim.processorSubscriptionId,
        claim.state,
        claim.version,
      ),
      secretKey,
    );
    return classifyStripeExecution(result);
  } catch {
    return classifyStripeExecution(null);
  }
}

export async function completeCollectionClaim(
  deps: CollectionExecutorDeps,
  subject: CollectionSubject,
  operationId: string,
  claim: CollectionClaim,
  outcome: CollectionSendOutcome,
): Promise<CollectionExecutionResult> {
  if (outcome.kind === 'unknown') {
    return { action: 'unknown', status: outcome.status };
  }

  const success = outcome.kind === 'success';
  let status = success ? 'succeeded' : 'failed';
  try {
    const response = await deps.identityFetch(new Request(IDENTITY_SETTLE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectKind: subject.subjectKind,
        subjectId: subject.subjectId,
        operationId,
        success,
        expectedVersion: claim.version,
      }),
    }));
    const body = recordOf(await readJson(response));
    if (typeof body?.status === 'string') status = body.status;
  } catch {
    console.error('[billing]', JSON.stringify({
      alert: 'collection_settle_failed',
      processorSubscriptionId: claim.processorSubscriptionId,
      version: claim.version,
    }));
  }

  if (!success) {
    console.error('[billing]', JSON.stringify({
      alert: 'collection_failed',
      processorSubscriptionId: claim.processorSubscriptionId,
      version: claim.version,
      status: outcome.status,
    }));
  }
  return { action: 'settled', status };
}

/**
 * Sends and settles a claim the caller already holds. The reconcile route
 * claims inside the IdentityDO, so the daily cron passes that claim here
 * instead of claiming a second time, which would be a no-op.
 */
export async function executeCollectionClaim(
  deps: CollectionExecutorDeps,
  subject: CollectionSubject,
  claim: CollectionClaim,
  operationId: string = crypto.randomUUID(),
): Promise<CollectionExecutionResult> {
  const outcome = await sendCollectionState(deps, claim);
  return completeCollectionClaim(deps, subject, operationId, claim, outcome);
}

export async function runCollectionExecutor(
  deps: CollectionExecutorDeps,
  subject: CollectionSubject,
): Promise<CollectionExecutionResult> {
  if (!deps.billing.apiBaseAllowed || deps.billing.secretKey === null) {
    return { action: 'none', reason: 'unavailable' };
  }
  const operationId = crypto.randomUUID();
  const claim = await claimCollectionExecution(deps, subject, operationId);
  if (claim === null) return { action: 'none', reason: 'no_claim' };
  return executeCollectionClaim(deps, subject, claim, operationId);
}

export type OutboundRetryOutcome = 'settled' | 'released' | 'pending' | 'unavailable';

async function settleOutboundViaSystem(
  deps: CollectionExecutorDeps,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await deps.identityFetch(new Request(IDENTITY_SYSTEM_SETTLE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return response.ok;
  } catch {
    console.error('[billing]', JSON.stringify({
      alert: 'outbound_settle_failed',
      kind: body.kind,
      outcome: 'failed',
    }));
    return false;
  }
}

async function settleSeatChangeOutcome(
  deps: CollectionExecutorDeps,
  operation: OutboundSeatChangeOperation,
  outcome: 'success' | 'failure' | 'unknown',
): Promise<OutboundRetryOutcome> {
  const settled = await settleOutboundViaSystem(deps, {
    kind: 'seat-change',
    companyId: operation.companyId,
    operationId: operation.operationId,
    outcome,
  });
  if (outcome === 'success') return settled ? 'settled' : 'pending';
  if (outcome === 'failure') return 'released';
  return 'pending';
}

export async function retrySeatChange(
  deps: CollectionExecutorDeps,
  operation: OutboundSeatChangeOperation,
): Promise<OutboundRetryOutcome> {
  const secretKey = deps.billing.secretKey;
  if (!deps.billing.apiBaseAllowed || secretKey === null) return 'unavailable';

  let fetched: StripeExecutionResult | null;
  try {
    fetched = await executeStripeRequest(
      new Request(
        `${deps.billing.apiBaseUrl}/v1/subscriptions/${operation.processorSubscriptionId}`,
        { method: 'GET' },
      ),
      secretKey,
    );
  } catch {
    fetched = null;
  }
  if (fetched === null || !fetched.ok) {
    return settleSeatChangeOutcome(deps, operation, 'unknown');
  }

  const decision = decideSeatChangeRecovery({
    previousQuantity: operation.previousQuantity,
    targetQuantity: operation.targetQuantity,
    fetchedQuantity: stripeSubscriptionItemQuantity(fetched.json),
    attemptedAt: operation.attemptedAt,
    now: Date.now(),
  });
  if (decision.kind === 'settled') {
    return settleSeatChangeOutcome(deps, operation, 'success');
  }
  if (decision.kind === 'released') {
    return settleSeatChangeOutcome(deps, operation, 'failure');
  }
  if (decision.kind === 'pending') {
    return 'pending';
  }
  if (decision.kind === 'drift') {
    console.error('[billing]', JSON.stringify({
      ...decision.alert,
      companyId: operation.companyId,
      operationId: operation.operationId,
      processorSubscriptionId: operation.processorSubscriptionId,
      outcome: 'released',
    }));
    return settleSeatChangeOutcome(deps, operation, 'failure');
  }

  const itemId = stripeSubscriptionItemId(fetched.json);
  if (itemId === null) {
    return settleSeatChangeOutcome(deps, operation, 'failure');
  }

  let updated: StripeExecutionResult | null;
  try {
    updated = await executeStripeRequest(
      seatItemUpdateRequest(deps.billing.apiBaseUrl, secretKey, {
        companyId: operation.companyId,
        operationId: operation.operationId,
        processorSubscriptionId: operation.processorSubscriptionId,
        itemId,
        targetQuantity: operation.targetQuantity,
        prorationBehavior: operation.prorationBehavior,
      }),
      secretKey,
    );
  } catch {
    updated = null;
  }
  if (updated === null) {
    return settleSeatChangeOutcome(deps, operation, 'unknown');
  }
  if (updated.ok) {
    return settleSeatChangeOutcome(deps, operation, 'success');
  }
  if (updated.status >= 400 && updated.status < 500) {
    return settleSeatChangeOutcome(deps, operation, 'failure');
  }
  return settleSeatChangeOutcome(deps, operation, 'unknown');
}

export async function retryCompanyCreate(
  deps: CollectionExecutorDeps,
  operation: OutboundCompanyCreateOperation,
): Promise<OutboundRetryOutcome> {
  const secretKey = deps.billing.secretKey;
  if (!deps.billing.apiBaseAllowed || secretKey === null) return 'unavailable';

  let result: StripeExecutionResult | null;
  try {
    result = await executeStripeRequest(
      companyCustomerRequest(deps.billing.apiBaseUrl, secretKey, {
        companyId: operation.companyId,
        operationId: operation.operationId,
        name: operation.name,
        accountId: operation.ownerAccountId,
      }),
      secretKey,
    );
  } catch {
    result = null;
  }
  if (result === null || !result.ok) {
    console.error('[billing]', JSON.stringify({
      alert: 'outbound_retry_failed',
      kind: 'company-create',
      companyId: operation.companyId,
      outcome: 'pending',
    }));
    return 'pending';
  }
  const customerId = recordOf(result.json)?.id;
  if (typeof customerId !== 'string' || !customerId.startsWith('cus_')) {
    return 'pending';
  }
  const settled = await settleOutboundViaSystem(deps, {
    kind: 'company-create',
    companyId: operation.companyId,
    operationId: operation.operationId,
    processorCustomerId: customerId,
  });
  return settled ? 'settled' : 'pending';
}

export async function retryOutboundOperation(
  deps: CollectionExecutorDeps,
  operation: OutboundOperation,
): Promise<OutboundRetryOutcome> {
  return operation.kind === 'company-create'
    ? retryCompanyCreate(deps, operation)
    : retrySeatChange(deps, operation);
}
