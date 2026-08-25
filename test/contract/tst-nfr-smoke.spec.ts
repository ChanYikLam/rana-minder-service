/**
 * TST-NFR-001~054 冒烟级抽样断言（P1-B 第三批；CI-004 发布门证据之一）。
 *
 * 定位（诚实边界）：
 * - 54 条 SRS-NFR 的正式验收合同在 docs/specification/测试规格与验收追踪-v1.0.md
 *   §10（逐条可执行合同），多数依赖参考环境压测/演练（OPS-VER/TVER/人工门），
 *   本套件**不冒充其通过**；
 * - 本套件只对"可在进程内客观断言"的代表性条目落地冒烟级断言（棘轮：只许上调），
 *   其余条目显式登记为待人工门/OPS-VER/TVER，并保持"未执行"，不得虚报。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ErrorCode } from '../../src/common/errors/error-code';

const ROOT = path.resolve(__dirname, '../..');
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));
const readRepo = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 权威总数：SRS-NFR-001~054（接口实现规格 §12 / 故障恢复质量约束文档） */
export const NFR_TOTAL = 54;

/** 全量编号（SRS-NFR-001..054，程序化生成防手滑跳号） */
export const ALL_NFR_IDS: readonly string[] = Array.from(
  { length: NFR_TOTAL },
  (_, i) => `SRS-NFR-${String(i + 1).padStart(3, '0')}`,
);

interface NfrSmoke {
  readonly ids: readonly string[];
  readonly title: string;
  /** 断言所依据的真实锚点文件 */
  readonly anchors: readonly string[];
  readonly run: () => void;
}

const SMOKES: readonly NfrSmoke[] = [
  {
    ids: ['SRS-NFR-005'],
    title: '开源许可证 MIT：原创代码许可与再分发声明落位',
    anchors: ['package.json'],
    run: () => {
      const pkg = JSON.parse(readRepo('package.json')) as { license?: string };
      assert.equal(pkg.license, 'MIT');
    },
  },
  {
    ids: ['SRS-NFR-033'],
    title: '升级预检与迁移失败处置：版本化迁移与锁文件可复现基线',
    anchors: ['pnpm-lock.yaml', 'src/database/migrations'],
    run: () => {
      assert.ok(exists('pnpm-lock.yaml'), '锁文件缺失——不可复现安装');
      assert.ok(exists('src/database/migrations'), '数据库迁移目录缺失');
    },
  },
  {
    ids: ['SRS-NFR-035'],
    title: '开源发布真实数据清零：秘密扫描门（gitleaks 0 命中）',
    anchors: ['.cnb.yml'],
    run: () => {
      const yml = readRepo('.cnb.yml');
      assert.match(yml, /9-秘密扫描/);
      assert.match(yml, /gitleaks/);
    },
  },
  {
    ids: ['SRS-NFR-037'],
    title: '正式文档最低集合：安装/Casdoor 配置/升级/备份恢复等关键文档存在',
    anchors: [
      'README.md',
      'docs/engineering/开发环境搭建指南-v1.0.md',
      'docs/engineering/CI流水线落地指南-v1.0.md',
      'docs/operations/部署运维与恢复手册-v1.0.md',
      'docs/specification/接口实现规格-v1.0.md',
    ],
    run: () => {
      for (const rel of [
        'README.md',
        'docs/engineering/开发环境搭建指南-v1.0.md',
        'docs/engineering/CI流水线落地指南-v1.0.md',
        'docs/operations/部署运维与恢复手册-v1.0.md',
        'docs/specification/接口实现规格-v1.0.md',
      ]) {
        assert.ok(exists(rel), `关键文档缺失: ${rel}`);
      }
    },
  },
  {
    ids: ['SRS-NFR-043'],
    title: '测试环境隔离：NODE_ENV=test 且不指向真实学校实例',
    anchors: ['.env.test'],
    run: () => {
      const env = readRepo('.env.test');
      assert.match(env, /NODE_ENV=test/);
      assert.doesNotMatch(env, /cnb\.cool|school\.edu|@ruc\.|真实/i);
    },
  },
  {
    ids: ['SRS-NFR-006'],
    title: '错误码契约完备：IFC-ERR-* 分类唯一且含外部不确定语义',
    anchors: ['src/common/errors/error-code.ts'],
    run: () => {
      const values = Object.values(ErrorCode);
      assert.ok(values.length >= 15, `错误码数量不足: ${values.length}`);
      assert.equal(new Set(values).size, values.length, '错误码存在重复');
      assert.equal(ErrorCode.EXTERNAL_UNKNOWN, 'IFC-ERR-013');
    },
  },
  {
    ids: ['SRS-NFR-007'],
    title: '生产入口固定且非浮动：镜像 CMD 锁定 node dist/main.js',
    anchors: ['Dockerfile'],
    run: () => {
      const dockerfile = readRepo('Dockerfile');
      assert.match(dockerfile, /CMD \["node", "dist\/main\.js"\]/);
      assert.doesNotMatch(dockerfile, /latest/);
    },
  },
  {
    ids: ['SRS-NFR-024'],
    title: '日志脱敏与保留策略规则化：脱敏规则与保留策略均有独立实现与测试',
    anchors: [
      'src/platform/observability/domain/services/redaction.rules.ts',
      'src/platform/observability/domain/services/redaction.rules.spec.ts',
      'src/platform/observability/domain/services/retention.rules.spec.ts',
    ],
    run: () => {
      for (const rel of [
        'src/platform/observability/domain/services/redaction.rules.ts',
        'src/platform/observability/domain/services/redaction.rules.spec.ts',
        'src/platform/observability/domain/services/retention.rules.spec.ts',
      ]) {
        assert.ok(exists(rel), `观测脱敏/保留实现缺失: ${rel}`);
      }
    },
  },
];

describe('TST-NFR 001~054 冒烟级抽样（P1-B 第三批）', () => {
  it('权威总数守恒：54 条编号唯一、无跳号', () => {
    assert.equal(ALL_NFR_IDS.length, NFR_TOTAL);
    assert.equal(new Set(ALL_NFR_IDS).size, NFR_TOTAL);
  });

  for (const smoke of SMOKES) {
    it(`冒烟[${smoke.ids.join('/')}] ${smoke.title}`, () => {
      for (const anchor of smoke.anchors) {
        assert.ok(exists(anchor), `${smoke.ids[0]} 锚点不存在: ${anchor}`);
      }
      smoke.run();
    });
  }

  it('棘轮：冒烟覆盖数只许上调（当前基线见 NFR_SMOKE_BASELINE）', () => {
    // 显式钉住当前抽样规模，防止后续悄悄删除断言
    assert.ok(SMOKES.length >= 8, `NFR 冒烟抽样不应少于当前基线 8，实际 ${SMOKES.length}`);
  });

  it('未抽样条目显式登记为人工门/OPS/TVER（不虚报为已执行）', () => {
    const smoked = new Set(SMOKES.flatMap((s) => s.ids));
    const pending = ALL_NFR_IDS.filter((id) => !smoked.has(id));
    // 其余条目的正式验收走 TST-NFR 合同（OPS-VER/TVER/人工门），保持"未执行"
    assert.ok(pending.length > 0, '未抽样条目应显式保留待执行状态');
    assert.equal(smoked.size + pending.length, NFR_TOTAL);
  });
});
