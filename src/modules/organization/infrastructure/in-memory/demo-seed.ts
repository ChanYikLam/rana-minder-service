/**
 * 开发/测试态演示种子（仅内存 Casdoor 桩使用；生产禁用内存桩，GOV-007）。
 */

import type { MemoryCasdoorSeed } from './memory-implementations';

export const DEMO_CASDOOR_SEED: MemoryCasdoorSeed = {
  groups: [
    {
      ref: { owner: 'builtin', name: '平台超管' },
      displayName: '平台超管',
      parentRef: null,
      memberIds: ['u_root'],
    },
    {
      ref: { owner: 'club-acm', name: 'ACM社团' },
      displayName: 'ACM社团',
      memberIds: ['u_a', 'u_b', 'u_c'],
    },
    {
      ref: { owner: 'club-acm', name: '负责人组' },
      displayName: '负责人组',
      parentRef: { owner: 'club-acm', name: 'ACM社团' },
      memberIds: ['u_a'],
    },
    {
      ref: { owner: 'club-acm', name: '人事组' },
      displayName: '人事组',
      parentRef: { owner: 'club-acm', name: 'ACM社团' },
      memberIds: ['u_b'],
    },
    {
      ref: { owner: 'club-acm', name: '宣传部' },
      displayName: '宣传部',
      parentRef: { owner: 'club-acm', name: 'ACM社团' },
      memberIds: ['u_c'],
    },
  ],
};
