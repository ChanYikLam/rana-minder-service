/**
 * 派生任务/外部调用关联——纯数据结构与工厂函数。
 *
 * 路径：src/platform/observability/tracing/（PR #32 §2.2 B）。
 *
 * 关联语义：
 * - http → command：HTTP 入口请求生成 root trace；命令接收时创建 child trace
 * - command → task：业务命令提交后台任务时记录 child trace 与 parent 关系
 * - task → external：任务执行外部调用时记录 child trace 与 parent 关系
 * - task → task：任务链（如 recompute→reconcile）记录 child trace 与 parent 关系
 *
 * 关联关系不编码进 ID 字符串本身（XCC-GEN-001）：通过显式字段 parentTraceId
 * 承载，由调用方写入结构化日志或 trace.parent_id 字段。
 */

import { isTraceId } from '../domain/services/trace-id.generator';

export type SpanKind = 'http' | 'command' | 'task' | 'external';

export interface SpanLink {
  readonly childTraceId: string;
  readonly parentTraceId?: string;
  readonly kind: SpanKind;
  readonly startedAt?: Date;
}

function assertValid(
  parentTraceId: string | undefined,
  childTraceId: string,
  kind: SpanKind,
): SpanLink {
  if (!isTraceId(childTraceId)) {
    throw new TypeError(`Invalid child trace id for ${kind} span: ${String(childTraceId)}`);
  }
  if (parentTraceId !== undefined && !isTraceId(parentTraceId)) {
    throw new TypeError(`Invalid parent trace id for ${kind} span: ${String(parentTraceId)}`);
  }
  return { childTraceId, parentTraceId, kind };
}

export interface SpanLinkFactory {
  linkHttpToCommand(httpTraceId: string, commandTraceId: string): SpanLink;
  linkCommandToTask(commandTraceId: string, taskTraceId: string): SpanLink;
  linkTaskToExternal(taskTraceId: string, externalTraceId: string): SpanLink;
  linkTaskToTask(parentTaskTraceId: string, childTaskTraceId: string): SpanLink;
}

export class DefaultSpanLinkFactory implements SpanLinkFactory {
  linkHttpToCommand(httpTraceId: string, commandTraceId: string): SpanLink {
    return assertValid(httpTraceId, commandTraceId, 'command');
  }

  linkCommandToTask(commandTraceId: string, taskTraceId: string): SpanLink {
    return assertValid(commandTraceId, taskTraceId, 'task');
  }

  linkTaskToExternal(taskTraceId: string, externalTraceId: string): SpanLink {
    return assertValid(taskTraceId, externalTraceId, 'external');
  }

  linkTaskToTask(parentTaskTraceId: string, childTaskTraceId: string): SpanLink {
    return assertValid(parentTaskTraceId, childTaskTraceId, 'task');
  }
}
