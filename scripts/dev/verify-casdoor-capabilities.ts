/**
 * 学校 Casdoor 实例能力验证脚本（scripts/dev；CAS-CAP-004/005/010、CAS-CAP-002）。
 *
 * 用途：接学校真实实例前的部署前证据门（只读探测，不做任何写入、不完成交互
 * 登录）。输出脱敏证据摘要（markdown 片段），供
 * `docs/_local/casdoor-capability-evidence-template.md` 填写。
 *
 * 用法（在 rana-minder-service-wt 目录）：
 *   RANAMINDER_CONFIG_FILE="$PWD/config.dev-real.yaml" \
 *     node -r ts-node/register scripts/dev/verify-casdoor-capabilities.ts
 *
 * 检查项：
 *   1. 发现文档（CAS-CAP-004 前置）：五端点齐备、issuer 非空、sha256 指纹
 *   2. JWKS：可取、密钥数量与算法
 *   3. PKCE 授权端点接受性：带 S256 code_challenge 的授权请求不报 4xx/5xx
 *      （部分证据；最终确认需一次交互式登录，见模板 §1 末行）
 *   4. 账号状态字段（CAS-CAP-005，可选）：提供 GDMU_TEST_ACCESS_TOKEN 时调
 *      get-account 校验 isForbidden/isDeleted 为 boolean；未提供则标 NOT-RUN
 *   5. 换码错误形态（CAS-CAP-010）：以伪造 code 换码，记录状态码与错误分类
 *      （不回显响应体——脱敏红线 CAS-CAP-015）
 *
 * 退出码：全部必需项通过 → 0；任一必需项失败 → 1（对应路径保持 fail-closed）。
 */

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config';

const FETCH_TIMEOUT_MS = 8000;
const DISCOVERY_PATH = '/.well-known/openid-configuration';

interface CheckResult {
  readonly name: string;
  readonly required: boolean;
  readonly ok: boolean | 'NOT_RUN';
  readonly detail: string;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  const config = loadConfig();
  const casdoor = config.casdoor;
  const results: CheckResult[] = [];

  if (!casdoor.endpoint) {
    console.error('配置缺失：casdoor.endpoint 为空（检查 RANAMINDER_CONFIG_FILE 指向）');
    return 1;
  }
  const endpoint = casdoor.endpoint.replace(/\/+$/, '');
  console.log(`# 学校 Casdoor 能力验证摘要\n`);
  console.log(`- 验证时间：${new Date().toISOString()}`);
  console.log(`- endpoint：${endpoint}`);
  console.log(`- organization：${casdoor.organization || '（未配置）'}`);
  console.log('');

  // ---- 1. 发现文档 ----
  let issuer = '';
  let jwksUri = '';
  let authorizationEndpoint = '';
  let tokenEndpoint = '';
  let fingerprint = '';
  try {
    const res = await fetchWithTimeout(`${endpoint}${DISCOVERY_PATH}`);
    if (!res.ok) {
      results.push({
        name: '发现文档可取（五端点 + issuer）',
        required: true,
        ok: false,
        detail: `HTTP ${res.status}`,
      });
    } else {
      const doc = (await res.json()) as Record<string, unknown>;
      issuer = String(doc['issuer'] ?? '');
      jwksUri = String(doc['jwks_uri'] ?? '');
      authorizationEndpoint = String(doc['authorization_endpoint'] ?? '');
      tokenEndpoint = String(doc['token_endpoint'] ?? '');
      const userinfo = String(doc['userinfo_endpoint'] ?? '');
      const endSession =
        typeof doc['end_session_endpoint'] === 'string' ? doc['end_session_endpoint'] : null;
      const endpointsOk = Boolean(
        issuer && jwksUri && authorizationEndpoint && tokenEndpoint && userinfo,
      );
      fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            issuer,
            authorizationEndpoint,
            tokenEndpoint,
            userinfo,
            jwksUri,
            endSession,
          ]),
        )
        .digest('hex');
      results.push({
        name: '发现文档可取（五端点 + issuer）',
        required: true,
        ok: endpointsOk,
        detail: endpointsOk ? `issuer=${issuer}` : `字段缺失（issuer=${issuer || '空'}）`,
      });
      console.log(`- 发现文档指纹（sha256）：\`${fingerprint}\``);
    }
  } catch (error) {
    results.push({
      name: '发现文档可取（五端点 + issuer）',
      required: true,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // ---- 2. JWKS ----
  if (jwksUri) {
    try {
      const res = await fetchWithTimeout(jwksUri);
      if (!res.ok) {
        results.push({
          name: 'JWKS 可取',
          required: true,
          ok: false,
          detail: `HTTP ${res.status}`,
        });
      } else {
        const doc = (await res.json()) as { keys?: Array<Record<string, unknown>> };
        const keys = Array.isArray(doc.keys) ? doc.keys : [];
        const algs = [...new Set(keys.map((k) => String(k['alg'] ?? 'unknown')))];
        results.push({
          name: 'JWKS 可取',
          required: true,
          ok: keys.length > 0,
          detail: `keys=${keys.length}，algs=${algs.join(',')}`,
        });
      }
    } catch (error) {
      results.push({
        name: 'JWKS 可取',
        required: true,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- 3. PKCE 授权端点接受性（部分证据）----
  if (authorizationEndpoint) {
    try {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
      const url = new URL(authorizationEndpoint);
      url.searchParams.set('client_id', casdoor.clientId || 'capability-probe');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', casdoor.redirectUri || `${endpoint}/callback-probe`);
      url.searchParams.set('scope', 'openid profile email');
      url.searchParams.set('state', 'capability-probe');
      url.searchParams.set('nonce', 'capability-probe');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      const res = await fetchWithTimeout(url.toString(), { redirect: 'manual' });
      // 授权端点正常表现为 3xx（跳登录页）或 200（渲染登录页）；4xx/5xx 视为拒绝
      const accepted = res.status < 400;
      results.push({
        name: 'PKCE S256 授权请求接受（部分证据）',
        required: false,
        ok: accepted,
        detail:
          `HTTP ${res.status}` +
          (accepted
            ? '；最终确认需一次交互式登录（模板 §1）'
            : '；授权端点拒绝带 challenge 的请求——与学校确认后可 pkceEnabled=false 并留档'),
      });
    } catch (error) {
      results.push({
        name: 'PKCE S256 授权请求接受（部分证据）',
        required: false,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- 4. 账号状态字段（CAS-CAP-005，可选）----
  const testToken = process.env['GDMU_TEST_ACCESS_TOKEN'];
  if (!testToken) {
    results.push({
      name: '账号状态字段（isForbidden/isDeleted 为 boolean）',
      required: false,
      ok: 'NOT_RUN',
      detail: '未提供 GDMU_TEST_ACCESS_TOKEN；用试点账号登录取 access_token 后重跑本项',
    });
  } else {
    try {
      const res = await fetchWithTimeout(`${endpoint}/api/get-account`, {
        headers: { Authorization: `Bearer ${testToken}` },
      });
      if (!res.ok) {
        results.push({
          name: '账号状态字段（isForbidden/isDeleted 为 boolean）',
          required: false,
          ok: false,
          detail: `get-account HTTP ${res.status}`,
        });
      } else {
        const body = (await res.json()) as { status?: string; data?: Record<string, unknown> };
        const user = body.data;
        const isForbidden = user?.['isForbidden'];
        const isDeleted = user?.['isDeleted'];
        const ok =
          body.status === 'ok' &&
          typeof isForbidden === 'boolean' &&
          typeof isDeleted === 'boolean';
        results.push({
          name: '账号状态字段（isForbidden/isDeleted 为 boolean）',
          required: false,
          ok,
          detail: ok
            ? `字段齐备（值不记录）；status=ok`
            : `字段缺失或非布尔（isForbidden=${typeof isForbidden}, isDeleted=${typeof isDeleted}）→ 登录路径将按 UNKNOWN fail-closed`,
        });
      }
    } catch (error) {
      results.push({
        name: '账号状态字段（isForbidden/isDeleted 为 boolean）',
        required: false,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- 5. 换码错误形态（CAS-CAP-010）----
  if (tokenEndpoint && casdoor.clientId) {
    try {
      const res = await fetchWithTimeout(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: casdoor.clientId,
          // client_secret 不发送：无效码路径无需真实秘密即可观察错误分类
          code: 'capability-probe-invalid-code',
          redirect_uri: casdoor.redirectUri,
        }),
      });
      // 期望 4xx（invalid code/grant）；2xx 或 5xx 均记录异常形态
      const classified = res.status >= 400 && res.status < 500;
      results.push({
        name: '换码错误形态（无效 code → 4xx 分类）',
        required: false,
        ok: classified,
        detail: `HTTP ${res.status}（响应体不记录——脱敏红线）`,
      });
    } catch (error) {
      results.push({
        name: '换码错误形态（无效 code → 4xx 分类）',
        required: false,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- 输出 ----
  console.log('\n| 检查项 | 必需 | 结果 | 说明 |');
  console.log('| --- | --- | --- | --- |');
  for (const r of results) {
    const okText = r.ok === 'NOT_RUN' ? 'NOT-RUN' : r.ok ? 'PASS' : 'FAIL';
    console.log(`| ${r.name} | ${r.required ? '必需' : '可选'} | ${okText} | ${r.detail} |`);
  }

  const failedRequired = results.filter((r) => r.required && r.ok === false);
  console.log(
    `\n结论：${failedRequired.length === 0 ? '必需项全部通过（可选未过项按模板评估）' : `必需项失败 ${failedRequired.length} 项 → 对应路径保持 fail-closed`}`,
  );
  console.log('提醒：本摘要不含任何令牌/秘密/完整响应；按模板补齐人工项后归档 docs/_local/。');
  return failedRequired.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('验证脚本异常失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
