/**
 * 表单定义/版本状态机（SRS-SM-FORM-001；IFC-SM-024）。
 *
 * 状态：草稿（DRAFT）→ 预览/测试（PREVIEW_TESTING）→ 草稿（可发布，publishable）
 *      → 已发布不可变版本（PUBLISHED）→ 已停用（DEPRECATED）。
 *
 * 版本级转换（t2~t8 落地）：
 * - UPDATE_DRAFT：DRAFT → DRAFT（原子存新草稿版本；草稿变更使测试通过标志失效）；
 * - RUN_PREVIEW_TEST：DRAFT → PREVIEW_TESTING（存测试快照与结果，测试不读越权真实数据，
 *   旧测试不能证明新草稿合格）；
 * - PREVIEW_TEST_FAILED：PREVIEW_TESTING → DRAFT（publishable=false）；
 * - PREVIEW_TEST_PASSED：PREVIEW_TESTING → DRAFT（publishable=true，不自动发布）；
 * - PUBLISH：DRAFT（publishable=true）→ PUBLISHED（不可变；并发发布只一个成为当前，
 *   失败时旧版本完整有效）；
 * - DEPRECATE：PUBLISHED → DEPRECATED（只阻止新提交，既有提交与附件保留；重复停用幂等）；
 * - REUSE：PUBLISHED/DEPRECATED 为合法来源（原版本状态不变，另建草稿）；
 * - RESTORE：DEPRECATED → 稳定拒绝（已停用是版本不可逆的发布结果，不存在直接重新启用
 *   的业务前置条件；必须基于来源版本建新草稿并重走预览/测试/发布流程，FORM-002/005、
 *   CFG-005、PRD-OPT-043）。
 *
 * 创建（t1）与复用（t6）涉及根指针与新建行，由聚合与用例编排；本机保证
 * 版本级转换前置条件与 t8 稳定拒绝语义。
 */

export const FormVersionState = {
  DRAFT: 'DRAFT',
  PREVIEW_TESTING: 'PREVIEW_TESTING',
  PUBLISHED: 'PUBLISHED',
  DEPRECATED: 'DEPRECATED',
} as const;
export type FormVersionState = (typeof FormVersionState)[keyof typeof FormVersionState];

export const FormVersionEvent = {
  UPDATE_DRAFT: 'UPDATE_DRAFT',
  RUN_PREVIEW_TEST: 'RUN_PREVIEW_TEST',
  PREVIEW_TEST_FAILED: 'PREVIEW_TEST_FAILED',
  PREVIEW_TEST_PASSED: 'PREVIEW_TEST_PASSED',
  PUBLISH: 'PUBLISH',
  DEPRECATE: 'DEPRECATE',
  REUSE: 'REUSE',
  RESTORE: 'RESTORE',
} as const;
export type FormVersionEvent = (typeof FormVersionEvent)[keyof typeof FormVersionEvent];

export interface FormVersionTransitionInput {
  readonly event: FormVersionEvent;
  readonly currentState: FormVersionState;
  /** 当前草稿是否已通过预览/测试（可发布标志；只对 DRAFT 有意义） */
  readonly publishable: boolean;
}

export interface FormVersionTransitionResult {
  readonly allowed: boolean;
  readonly nextState: FormVersionState;
  /** 转换后的可发布标志（发布/停用后清空） */
  readonly publishable: boolean;
  /** 拒绝原因（不猜测下一状态，IFC-ERR-007 语义） */
  readonly reason: string | null;
}

export interface FormVersionStateMachine {
  transition(input: FormVersionTransitionInput): FormVersionTransitionResult;
}

export class DefaultFormVersionStateMachine implements FormVersionStateMachine {
  transition(input: FormVersionTransitionInput): FormVersionTransitionResult {
    const current = input.currentState;
    if (current === FormVersionState.DRAFT) {
      switch (input.event) {
        case FormVersionEvent.UPDATE_DRAFT:
          return {
            allowed: true,
            nextState: FormVersionState.DRAFT,
            publishable: false,
            reason: null,
          };
        case FormVersionEvent.RUN_PREVIEW_TEST:
          return {
            allowed: true,
            nextState: FormVersionState.PREVIEW_TESTING,
            publishable: false,
            reason: null,
          };
        case FormVersionEvent.PUBLISH:
          if (!input.publishable) {
            return {
              allowed: false,
              nextState: current,
              publishable: false,
              reason: '草稿未通过预览/测试，不可发布',
            };
          }
          return {
            allowed: true,
            nextState: FormVersionState.PUBLISHED,
            publishable: false,
            reason: null,
          };
        case FormVersionEvent.DEPRECATE:
          return {
            allowed: false,
            nextState: current,
            publishable: input.publishable,
            reason: '仅已发布版本可停用',
          };
        case FormVersionEvent.REUSE:
          return {
            allowed: false,
            nextState: current,
            publishable: input.publishable,
            reason: '草稿不是复用来源（仅已发布/已停用版本可作来源）',
          };
        default:
          return {
            allowed: false,
            nextState: current,
            publishable: input.publishable,
            reason: '当前状态不允许该事件',
          };
      }
    }
    if (current === FormVersionState.PREVIEW_TESTING) {
      if (input.event === FormVersionEvent.PREVIEW_TEST_FAILED) {
        return {
          allowed: true,
          nextState: FormVersionState.DRAFT,
          publishable: false,
          reason: null,
        };
      }
      if (input.event === FormVersionEvent.PREVIEW_TEST_PASSED) {
        return {
          allowed: true,
          nextState: FormVersionState.DRAFT,
          publishable: true,
          reason: null,
        };
      }
      return {
        allowed: false,
        nextState: current,
        publishable: false,
        reason: '预览/测试中仅接受测试结果（通过/失败）',
      };
    }
    if (current === FormVersionState.PUBLISHED) {
      if (input.event === FormVersionEvent.DEPRECATE) {
        return {
          allowed: true,
          nextState: FormVersionState.DEPRECATED,
          publishable: false,
          reason: null,
        };
      }
      if (input.event === FormVersionEvent.REUSE) {
        return {
          allowed: true,
          nextState: current,
          publishable: false,
          reason: null,
        };
      }
      return {
        allowed: false,
        nextState: current,
        publishable: false,
        reason: '已发布版本不可原地修改或覆盖（变更须发布新版本）',
      };
    }
    if (current === FormVersionState.DEPRECATED) {
      if (input.event === FormVersionEvent.REUSE) {
        return {
          allowed: true,
          nextState: current,
          publishable: false,
          reason: null,
        };
      }
      return {
        allowed: false,
        nextState: current,
        publishable: false,
        reason: '已停用版本不可直接重新启用，必须基于来源版本创建新草稿并重新发布新版本',
      };
    }
    return {
      allowed: false,
      nextState: current,
      publishable: false,
      reason: '未知版本状态',
    };
  }
}
