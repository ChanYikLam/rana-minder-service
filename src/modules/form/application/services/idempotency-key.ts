/**
 * 幂等语义摘要（IFC-GEN-006：服务端按版本化规范化规则计算语义摘要）。
 *
 * 客户端不得自报身份、权限或作用域；摘要只取服务端已冻结的命令输入
 * （作用域、标题、来源版本等稳定字段），排除时间戳与随机标识。
 */

import { createHash } from 'node:crypto';

export function semanticHashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
