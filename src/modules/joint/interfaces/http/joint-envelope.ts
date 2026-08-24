/**
 * 联合请求信封解析（interfaces/http；API-GEN-003 统一信封）。
 *
 * 业务字段只读 input；不兼容平铺写法。
 */

export interface JointRequestEnvelope<TInput = unknown> {
  readonly action?: string;
  readonly targetId?: string;
  readonly expectedVersion?: number;
  readonly idempotencyKey?: string;
  readonly input?: TInput;
}

export function parseJointRequestEnvelope(body: unknown): JointRequestEnvelope {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { input: {} as unknown };
  }
  const obj = body as Record<string, unknown>;
  return {
    action: typeof obj.action === 'string' ? obj.action : undefined,
    targetId: typeof obj.targetId === 'string' ? obj.targetId : undefined,
    expectedVersion: typeof obj.expectedVersion === 'number' ? obj.expectedVersion : undefined,
    idempotencyKey: typeof obj.idempotencyKey === 'string' ? obj.idempotencyKey : undefined,
    input: (obj.input ?? {}) as unknown,
  };
}
