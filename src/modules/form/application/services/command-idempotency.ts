/**
 * 创建类命令幂等门（IFC-GEN-006 两阶段协议落地）。
 *
 * begin()：claim 占位；新占位 → proceed；既有同摘要 → 读原结果重放（结果未
 * 回填时返回处理中 IFC-ERR-014）；既有异摘要 → 409 IFC-ERR-009。
 * finish()：业务事实落库成功后回填结果（幂等记录与业务事实同会话）。
 */

import type { FormIdempotencyStore } from '../ports/form-idempotency-store.port';
import { FormCommandError, FormErrorCode, formErrors } from '../errors';

export interface CommandIdempotencyBegin {
  readonly proceed: boolean;
  /** proceed=false 时的原结果（同摘要重放；未回填为 null） */
  readonly replay: unknown | null;
}

export class CommandIdempotencyGate {
  constructor(
    private readonly store: FormIdempotencyStore,
    private readonly scopeKey: string,
    private readonly idempotencyKey: string | undefined,
    private readonly semanticHash: string,
  ) {}

  async begin(): Promise<CommandIdempotencyBegin> {
    if (this.idempotencyKey === undefined) {
      return { proceed: true, replay: null };
    }
    const outcome = await this.store.claim({
      scopeKey: this.scopeKey,
      idempotencyKey: this.idempotencyKey,
      semanticHash: this.semanticHash,
    });
    if (outcome.inserted) {
      return { proceed: true, replay: null };
    }
    if (outcome.existingHash !== this.semanticHash) {
      throw formErrors.idempotencyConflict();
    }
    const result = await this.store.readResult(this.scopeKey, this.idempotencyKey);
    if (result === null) {
      throw new FormCommandError(FormErrorCode.PROCESSING, '相同请求正在处理中，请稍后重试');
    }
    return { proceed: false, replay: result };
  }

  async finish(result: unknown): Promise<void> {
    if (this.idempotencyKey === undefined) {
      return;
    }
    await this.store.complete({
      scopeKey: this.scopeKey,
      idempotencyKey: this.idempotencyKey,
      semanticHash: this.semanticHash,
      result,
    });
  }
}
