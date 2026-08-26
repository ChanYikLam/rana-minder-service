/**
 * TST-NFR-040 ~ 045：响应式终端一致、浏览器矩阵、内置浏览器引导、
 * 简体中文与国际化结构、键盘/标签/非纯颜色提示、对比度数值门槛。
 *
 * 前端应用尚未开工（apps/web 仅占位），本套件自动化其"权威约束在场"部分：
 * 全部规则必须冻结在前端/UIUX 权威文档与 SRS 行中，且后端错误信封已按
 * code/message/supportId 最小披露承载（前端按 code 渲染本地化文案的结构基础）。
 * 真实页面级执行仍属 RV-WEB 人工/CI 演练范围。
 *
 * - TST-NFR-040：响应式 Web 双端能力一致，无原生 App 承诺；
 * - TST-NFR-041：五类浏览器近期两个主要版本矩阵以发布日为基准；
 * - TST-NFR-042：内置浏览器认证受限时引导转系统浏览器且不宣称登录成功；
 * - TST-NFR-043：首期简体中文 + 可维护文案资源结构；
 * - TST-NFR-044：键盘可达、标签关联、非纯颜色提示约束在场；
 * - TST-NFR-045：对比度数值门槛（普通文字 4.5:1 / 大号与非文本 3:1）在册且设计令牌给出实测值。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readRepo } from './nfr-support';
import { toApiError } from '../../src/modules/identity/interfaces/http/error-http';
import {
  IdentityCommandError,
  IdentityErrorCode,
} from '../../src/modules/identity/application/errors';
import { IFC_ERROR_CODES } from '../../src/common/contracts/api-error';

const uiuxSpec = (): string => readRepo('docs/frontend/前端UIUX设计规范-v1.0.md');
const srsDoc = (): string => readRepo('docs/specification/SRS-v1.0.md');
const testSpec = (): string => readRepo('docs/specification/测试规格与验收追踪-v1.0.md');

// ---------------------------------------------------------------------------
// TST-NFR-040：电脑与手机业务能力一致
// ---------------------------------------------------------------------------

describe('TST-NFR-040 电脑与手机业务能力一致', () => {
  it('TST-NFR-040: 响应式双端能力一致为已确认约束，且不承诺原生 App', () => {
    const uiux = uiuxSpec();
    assert.match(
      uiux,
      /响应式一致 \| 电脑与手机业务能力一致；布局可不同，关键操作、结果和授权不得只在电脑端存在/,
    );
    // 首期不要求原生 App：技术栈约束显式声明"响应式 Web，无原生 App"
    assert.match(uiux, /响应式 Web，无原生 App/);
    // 上游验收合同同样声明布局可不同、授权不得只在电脑端存在
    assert.match(testSpec(), /布局可以不同，但关键操作、结果和授权不得只在电脑端存在/);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-041 / 042：浏览器矩阵与内置浏览器引导
// ---------------------------------------------------------------------------

describe('TST-NFR-041 正式支持浏览器矩阵', () => {
  it('TST-NFR-041: 五类浏览器近期两个主要版本矩阵冻结在 SRS 与测试规格', () => {
    const srs = srsDoc();
    for (const browser of ['Chrome', 'Edge', 'Safari']) {
      assert.ok(srs.includes(browser), `浏览器矩阵缺少 ${browser}`);
    }
    assert.match(
      testSpec(),
      /Chrome、Edge、Safari、Android Chrome 和 iPhone Safari 当时近期两个主要版本/,
    );
    // 版本随发布日滚动，不永久绑定编写时版本号
    assert.match(testSpec(), /“近期两个主要版本”随发布日滚动，不永久绑定编写 SRS 时的版本号/);
  });
});

describe('TST-NFR-042 内置浏览器引导与手机附件来源', () => {
  it('TST-NFR-042: 认证受限时明确引导转系统浏览器且不宣称登录成功；拍照/相册来源在册', () => {
    const contract = readRepo('docs/specification/测试规格与验收追踪-v1.0.md');
    assert.match(contract, /认证受限时明确引导转系统浏览器且不宣称登录成功/);
    assert.match(contract, /手机端可以拍照或从相册选择附件并继续现有上传检查流程/);
    // 引导不得携带免登录业务访问或泄露敏感参数
    assert.match(contract, /系统浏览器引导不能携带免登录业务访问或泄露敏感参数/);
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-043：简体中文与国际化结构
// ---------------------------------------------------------------------------

describe('TST-NFR-043 简体中文与国际化结构', () => {
  it('TST-NFR-043: 用户可见文案由可维护资源承载——错误码目录稳定、本地化由前端渲染', () => {
    // 后端结构基础：17 类稳定错误码只增不改；message 为安全可披露最小原因
    assert.equal(IFC_ERROR_CODES.length, 17);
    assert.deepEqual(IFC_ERROR_CODES.slice(0, 3), ['IFC-ERR-001', 'IFC-ERR-002', 'IFC-ERR-003']);
    const result = toApiError(
      new IdentityCommandError(IdentityErrorCode.UNAUTHENTICATED, '未认证'),
    );
    assert.equal(result.body.code, 'IFC-ERR-001');
    assert.equal(typeof result.body.message, 'string');
    // 文案资源与国际化结构要求冻结在前端技术设计：首期只交付简体中文，保留资源层
    const techDesign = readRepo('docs/frontend/前端技术设计-v1.0.md');
    assert.match(techDesign, /首期只交付简体中文，但保留国际化结构/);
    assert.match(techDesign, /locales\/\s*#\s*国际化资源结构|locales/);
    // 第二种语言不属于首期交付（边界冻结）
    assert.match(techDesign, /首期简体中文并保留国际化资源结构；第二种语言不属于首期交付/);
  });

  it('TST-NFR-043: 后端用户可见消息为中文文案（首期语言基线抽样）', () => {
    const samples = [
      new IdentityCommandError(IdentityErrorCode.UNAUTHENTICATED, '未认证').message,
      new IdentityCommandError(IdentityErrorCode.FORBIDDEN, '无权限').message,
      new IdentityCommandError(
        IdentityErrorCode.REAUTH_REQUIRED,
        '高风险操作要求最近 10 分钟内重新认证',
      ).message,
    ];
    for (const message of samples) {
      assert.match(message, /[\u4e00-\u9fa5]/, `用户可见消息应提供中文：${message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// TST-NFR-044 / 045：可访问性
// ---------------------------------------------------------------------------

describe('TST-NFR-044 键盘、标签与非纯颜色提示', () => {
  it('TST-NFR-044: 键盘可达与非纯颜色提示为已确认约束（状态/错误不得仅靠颜色表达）', () => {
    const uiux = uiuxSpec();
    // 已确认可访问性约束行：状态、错误和权限结果不得仅用颜色表达；核心流程必须可由键盘完成
    assert.match(uiux, /状态、错误和权限结果不得仅用颜色表达；核心流程必须可由键盘完成/);
    // 上游合同同样独立于颜色表达
    const contract = readRepo('docs/specification/测试规格与验收追踪-v1.0.md');
    assert.match(
      contract,
      /核心操作可通过键盘完成且不会陷入无法退出的交互；控件有可理解标签；错误和状态不只靠颜色表达/,
    );
  });
});

describe('TST-NFR-045 对比度数值门槛', () => {
  it('TST-NFR-045: WCAG 数值门槛冻结且设计令牌携带实测对比度（≥4.5:1 与 ≥3:1）', () => {
    const contract = readRepo('docs/specification/测试规格与验收追踪-v1.0.md');
    // 普通文字 ≥4.5:1；大号文字与非文本组件 ≥3:1
    assert.match(
      contract,
      /普通文字对比度至少 4\.5:1，大号文字至少 3:1，必要的非文本界面组件和状态图形至少 3:1/,
    );
    // 达到阈值不宣称完整 AA 认证（边界同样冻结）
    assert.match(
      uiuxSpec(),
      /达到 WCAG 2\.2 对应 AA 数值（对比度、键盘、非纯颜色提示），不扩大为完整 AA 认证/,
    );
    // 设计令牌已给出实测数值样例（如 8.14:1 / 4.80:1），证明测量口径可重复
    const uiux = uiuxSpec();
    assert.match(uiux, /8\.14:1/);
    assert.match(uiux, /4\.80:1/);
  });
});
