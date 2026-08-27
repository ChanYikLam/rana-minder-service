#!/usr/bin/env node
/**
 * RanaMinder OpenAPI 3.0 接口源生成器
 *
 * 静态解析 src 下全部已注册的 NestJS HTTP 控制器（@Controller 装饰器），
 * 输出统一 OpenAPI 3.0 规格文件，供 Apifox / Postman 一键导入：
 *   - docs/api/openapi.yaml
 *   - docs/api/openapi.json
 *
 * 覆盖能力：
 *   - 路径/HTTP 方法/路径参数/查询参数/请求体
 *   - 类级与方法级守卫（@UseGuards → bearerAuth 安全声明）
 *   - @HttpCode 状态码覆盖
 *   - JSDoc 摘要/描述
 *   - 统一请求信封 ApiRequestEnvelope 与响应信封 ApiSuccess/ApiError 组件
 *   - 尽力解析命名 DTO（同文件 interface/type/class + src/common/contracts）为 JSON Schema
 *
 * 用法：node scripts/generate-openapi.js
 * 约定：输出文件为生成产物，勿手工编辑；控制器变化后重跑本脚本即可。
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const OUT_DIR = path.join(ROOT, 'docs', 'api');
const CONTRACTS_DIR = path.join(SRC_DIR, 'common', 'contracts');

const HTTP_METHODS = new Map([
  ['Get', 'get'],
  ['Post', 'post'],
  ['Put', 'put'],
  ['Patch', 'patch'],
  ['Delete', 'delete'],
  ['Head', 'head'],
  ['Options', 'options'],
]);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (
      (entry.name.endsWith('.controller.ts') || entry.name.endsWith('-controller.ts')) &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function createSource(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function decoratorName(decorator) {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr)) {
    return expr.expression.getText();
  }
  if (ts.isIdentifier(expr)) {
    return expr.getText();
  }
  return expr.getText();
}

function firstStringArg(decorator) {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return undefined;
  const first = expr.arguments[0];
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    return first.text;
  }
  if (ts.isTemplateExpression(first)) {
    // 简单模板串（仅含 ${} 的场景在 Nest 路由中不应出现，保守返回 undefined）
    return undefined;
  }
  return undefined;
}

function numericArg(decorator) {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return undefined;
  const first = expr.arguments[0];
  if (ts.isNumericLiteral(first)) return Number(first.text);
  return undefined;
}

/** 从装饰器参数中收集守卫标识符（@UseGuards(AuthGuard, XGuard) → ['AuthGuard','XGuard']） */
function guardsOf(decorator) {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) return [];
  const out = [];
  for (const arg of expr.arguments) {
    if (ts.isIdentifier(arg)) out.push(arg.getText());
    else if (ts.isPropertyAccessExpression(arg)) out.push(arg.name.getText());
    else out.push(arg.getText());
  }
  return out;
}

function getJSDoc(node) {
  const tags = ts.getJSDocCommentsAndTags(node);
  const doc = tags.find((t) => t.kind === ts.SyntaxKind.JSDoc);
  if (!doc) return { summary: undefined, description: undefined };
  const comment = doc.comment;
  const text =
    typeof comment === 'string'
      ? comment
      : Array.isArray(comment)
        ? comment.map((c) => (typeof c === 'string' ? c : c.text)).join('')
        : '';
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  return {
    summary: firstLine || undefined,
    description: text.trim() || undefined,
  };
}

/** 提取一个类声明上的装饰器列表 */
function getDecorators(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function isTypeReference(t) {
  return t && t.typeArguments && t.typeArguments.length > 0;
}

// ---------------------------------------------------------------------------
// 类型注册表（命名类型 → AST 声明），用于 DTO → JSON Schema 尽力解析
// ---------------------------------------------------------------------------

class TypeRegistry {
  constructor() {
    /** @type {Map<string, { node: ts.Node, file: string }>} */
    this.map = new Map();
    /** @type {Map<string, { node: ts.Node, file: string }>} 全 src 全局索引（惰性构建） */
    this.globalMap = new Map();
    this.globalBuilt = false;
    this.cycleGuard = new Set();
    this.schemaCache = new Map();
  }

  register(name, node, file) {
    if (!this.map.has(name)) this.map.set(name, { node, file });
  }

  /** 惰性构建全局类型索引：解析所有非 spec 的 src .ts 文件，登记命名类型声明 */
  buildGlobalIndex() {
    if (this.globalBuilt) return;
    this.globalBuilt = true;
    const files = [];
    const walkDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) files.push(full);
      }
    };
    walkDir(SRC_DIR);
    for (const f of files) {
      let sf;
      try {
        sf = createSource(f);
      } catch {
        continue;
      }
      const visit = (node) => {
        if (
          (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) &&
          node.name
        ) {
          if (!this.globalMap.has(node.name.getText())) {
            this.globalMap.set(node.name.getText(), { node, file: f });
          }
        } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
          if (isConstObjectDecl(node) && !this.globalMap.has(node.name.getText())) {
            this.globalMap.set(node.name.getText(), { node, file: f });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  lookup(name) {
    if (this.map.has(name)) return this.map.get(name);
    if (!this.globalBuilt) this.buildGlobalIndex();
    return this.globalMap.get(name);
  }

  /** 解析类型名到 JSON Schema（$ref 优先，避免深度展开爆炸） */
  resolve(name, depth = 0) {
    if (depth > 4) return { $ref: `#/components/schemas/${name}` };
    const hit = this.lookup(name);
    if (!hit) return undefined;
    if (this.cycleGuard.has(name)) return { $ref: `#/components/schemas/${name}` };
    this.cycleGuard.add(name);
    let schema;
    try {
      schema = typeNodeToSchema(hit.node, this, depth + 1);
    } finally {
      this.cycleGuard.delete(name);
    }
    if (!schema || (schema.type === 'object' && !Object.keys(schema.properties ?? {}).length && !schema.enum && !schema.anyOf && !schema.additionalProperties)) {
      return { $ref: `#/components/schemas/${name}` };
    }
    // 尽量以命名类型为组件，便于 Apifox 展开
    this.schemaCache.set(name, schema);
    return { $ref: `#/components/schemas/${name}` };
  }

  toComponents() {
    const comp = {};
    for (const [name, schema] of [...this.schemaCache.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      comp[name] = schema;
    }
    return comp;
  }
}

/** 解开 as const / satisfies 等表达式包装 */
function unwrapExpr(expr) {
  let e = expr;
  while (e && (ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
  return e;
}

/** 判断一个 VariableDeclaration 是否可作常量对象枚举源 */
function isConstObjectDecl(node) {
  if (!node || !ts.isVariableDeclaration(node)) return false;
  const init = unwrapExpr(node.initializer);
  return !!init && ts.isObjectLiteralExpression(init);
}

function primType(kw) {
  switch (kw) {
    case 'string':
      return { type: 'string' };
    case 'number':
    case 'int':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'Date':
      return { type: 'string', format: 'date-time' };
    default:
      return undefined;
  }
}

/**
 * 解析 `(typeof X)[keyof typeof X]` 形式的联合 → 常量对象字面量值的枚举 Schema。
 * 也兼容 `typeof X` 直接引用（此时返回其值的联合）。
 */
function resolveConstUnion(typeNode, registry) {
  const tryResolve = (ref) => {
    // ref: 形如 typeof FileCategory 或 X
    let name = ref;
    if (name.startsWith('typeof ')) name = name.slice('typeof '.length).trim();
    const hit = registry.lookup(name);
    if (!hit || !ts.isVariableDeclaration(hit.node)) return undefined;
    const init = unwrapExpr(hit.node.initializer);
    if (!init || !ts.isObjectLiteralExpression(init)) return undefined;
    const values = [];
    for (const prop of init.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const v = unwrapExpr(prop.initializer);
      if (ts.isStringLiteral(v)) values.push(v.text);
      else if (ts.isNumericLiteral(v)) values.push(Number(v.text));
      else if (v.kind === ts.SyntaxKind.TrueKeyword) values.push(true);
      else if (v.kind === ts.SyntaxKind.FalseKeyword) values.push(false);
    }
    if (values.length === 0) return undefined;
    const allStr = values.every((v) => typeof v === 'string');
    return {
      type: allStr ? 'string' : undefined,
      ...(allStr ? { enum: values } : { enum: values }),
      description: '常量键联合（见源常量对象）',
    };
  };

  if (ts.isTypeQueryNode(typeNode)) {
    return tryResolve(typeNode.exprName.getText());
  }
  if (ts.isIndexedAccessTypeNode(typeNode) && ts.isTypeQueryNode(typeNode.objectType)) {
    return tryResolve(typeNode.objectType.exprName.getText());
  }
  return undefined;
}

function typeNodeToSchema(node, registry, depth = 0) {
  if (!node) return {};
  if (depth > 6) return {};

  // 括号
  if (ts.isParenthesizedTypeNode(node)) return typeNodeToSchema(node.type, registry, depth + 1);

  // 关键字（string/number/boolean 等）——TS 无 isKeywordTypeNode，按 kind 判断
  if (
    node.kind === ts.SyntaxKind.StringKeyword ||
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.AnyKeyword ||
    node.kind === ts.SyntaxKind.UnknownKeyword ||
    node.kind === ts.SyntaxKind.NeverKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    node.kind === ts.SyntaxKind.VoidKeyword ||
    node.kind === ts.SyntaxKind.ObjectKeyword
  ) {
    const prim =
      node.kind === ts.SyntaxKind.StringKeyword
        ? 'string'
        : node.kind === ts.SyntaxKind.NumberKeyword
          ? 'number'
          : node.kind === ts.SyntaxKind.BooleanKeyword
            ? 'boolean'
            : '';
    if (prim) return { type: prim };
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) {
      return { nullable: true };
    }
    return {};
  }

  // 类型引用（命名类型 / 泛型）
  if (ts.isTypeReferenceNode(node)) {
    const typeName = node.typeName.getText();
    const prim = primType(typeName);
    if (prim) return prim;

    // 二进制字节类型
    if (typeName === 'Uint8Array' || typeName === 'Buffer') {
      return { type: 'string', format: 'binary', description: '二进制数据（JSON 序列化为 base64，上传场景为 FormData 文件流）' };
    }

    // 泛型：Array<T> / Promise<T> / Record<K,V> / Partial<T>
    if (typeName === 'Array' || typeName === 'ReadonlyArray' || typeName === 'Promise') {
      const item = node.typeArguments?.[0];
      if (typeName === 'Promise') return typeNodeToSchema(item, registry, depth + 1);
      return { type: 'array', items: typeNodeToSchema(item, registry, depth + 1) };
    }
    if (typeName === 'Record') {
      const value = node.typeArguments?.[1];
      return {
        type: 'object',
        additionalProperties: typeNodeToSchema(value, registry, depth + 1),
      };
    }
    if (typeName === 'Partial') {
      const inner = node.typeArguments?.[0];
      const schema = typeNodeToSchema(inner, registry, depth + 1);
      if (schema && schema.properties) {
        for (const p of Object.keys(schema.properties)) {
          const prop = schema.properties[p];
          schema.required = (schema.required ?? []).filter((r) => r !== p);
          schema.properties[p] = { ...prop, description: `${prop.description ?? ''}（可选）`.trim() };
        }
      }
      return schema;
    }
    if (typeName === 'Readonly') {
      return typeNodeToSchema(node.typeArguments?.[0], registry, depth + 1);
    }

    // 命名类型：registry 解析
    const resolved = registry.resolve(typeName, depth);
    return resolved ?? {};
  }

  // 数组 T[]
  if (ts.isArrayTypeNode(node)) {
    return { type: 'array', items: typeNodeToSchema(node.elementType, registry, depth + 1) };
  }

  // 字面量类型（'a' | 'b' 中的单个 / 数值 / 布尔）
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit)) return { const: lit.text };
    if (ts.isNumericLiteral(lit)) return { const: Number(lit.text) };
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return { const: true };
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return { const: false };
    return {};
  }

  // 联合类型
  if (ts.isUnionTypeNode(node)) {
    const members = node.types;
    const nonNull = members.filter((m) => !(ts.isLiteralTypeNode(m) && m.literal.kind === ts.SyntaxKind.NullKeyword));
    const hasNull = nonNull.length !== members.length;

    // 纯字符串字面量联合 → enum
    const allStringLits = nonNull.every(
      (m) =>
        ts.isLiteralTypeNode(m) &&
        (ts.isStringLiteral(m.literal) || ts.isNoSubstitutionTemplateLiteral(m.literal)),
    );
    if (allStringLits && nonNull.length > 0) {
      const schema = {
        type: 'string',
        enum: nonNull.map((m) => (m.literal).text),
      };
      if (hasNull) schema.nullable = true;
      return schema;
    }

    if (nonNull.length === 1) {
      const inner = typeNodeToSchema(nonNull[0], registry, depth + 1);
      if (hasNull) inner.nullable = true;
      return inner;
    }
    const anyOf = nonNull.map((m) => typeNodeToSchema(m, registry, depth + 1));
    return { anyOf, ...(hasNull ? { nullable: true } : {}) };
  }

  // 对象字面量类型 { a: string; b?: number }
  if (ts.isTypeLiteralNode(node)) {
    return objectMembersToSchema(node.members, registry, depth);
  }

  // 索引访问 (typeof X)[keyof typeof X] → 常量对象值的枚举
  if (ts.isIndexedAccessTypeNode(node)) {
    const resolved = resolveConstUnion(node, registry);
    if (resolved) return resolved;
    return {};
  }

  // 常量对象声明（如 export const FileCategory = {...} as const）→ 其值联合枚举
  if (ts.isVariableDeclaration(node)) {
    const init = unwrapExpr(node.initializer);
    if (init && ts.isObjectLiteralExpression(init)) {
      const values = [];
      for (const prop of init.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const v = unwrapExpr(prop.initializer);
        if (ts.isStringLiteral(v)) values.push(v.text);
        else if (ts.isNumericLiteral(v)) values.push(Number(v.text));
        else if (v.kind === ts.SyntaxKind.TrueKeyword) values.push(true);
        else if (v.kind === ts.SyntaxKind.FalseKeyword) values.push(false);
      }
      if (values.length > 0) {
        return { type: typeof values[0] === 'string' ? 'string' : typeof values[0] === 'number' ? 'number' : 'boolean', enum: values };
      }
    }
    return {};
  }

  // interface / type 别名 / class 声明（当直接从 registry 拿到声明节点时）
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) {
    if (ts.isTypeAliasDeclaration(node)) {
      // 形如 type X = (typeof X)[keyof typeof X] 的常量键联合 → 解析常量对象字面量
      const resolvedConst = resolveConstUnion(node.type, registry);
      if (resolvedConst) return resolvedConst;
      return typeNodeToSchema(node.type, registry, depth + 1);
    }
    if (ts.isInterfaceDeclaration(node)) {
      const merged = [...node.members];
      // 合并 extends 的父接口
      for (const clause of node.heritageClauses ?? []) {
        for (const t of clause.types) {
          const parentName = t.expression.getText();
          const parent = registry.lookup(parentName);
          if (parent && ts.isInterfaceDeclaration(parent.node)) {
            merged.unshift(...parent.node.members);
          }
        }
      }
      return objectMembersToSchema(merged, registry, depth);
    }
    if (ts.isClassDeclaration(node)) {
      const props = node.members.filter((m) => ts.isPropertyDeclaration(m));
      return objectMembersToSchema(props, registry, depth);
    }
  }

  return {};
}

function objectMembersToSchema(members, registry, depth) {
  const properties = {};
  const required = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) continue;
    const name = member.name?.getText();
    if (!name) continue;
    let typeNode = member.type;
    // 无显式类型时尝试从初始化器推断
    if (!typeNode && ts.isPropertyDeclaration(member) && member.initializer) {
      const init = member.initializer;
      if (ts.isStringLiteral(init)) typeNode = ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
      else if (ts.isNumericLiteral(init)) typeNode = ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      else if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword)
        typeNode = ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    }
    let schema = typeNode ? typeNodeToSchema(typeNode, registry, depth + 1) : {};
    const isOptional = member.questionToken !== undefined || (member.type?.kind === ts.SyntaxKind.UnionTypeNode && member.type.types.some((t) => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.UndefinedKeyword));
    if (isOptional && !schema.nullable) {
      // 保留字段但不加入 required
    }
    if (!isOptional) required.push(name);
    const doc = getJSDoc(member);
    if (doc.summary && !schema.description) schema.description = doc.summary;
    properties[name] = schema;
  }
  const out = { type: 'object', properties };
  if (required.length) out.required = required;
  return out;
}

// ---------------------------------------------------------------------------
// 控制器解析
// ---------------------------------------------------------------------------

function moduleNameOf(filePath) {
  const norm = filePath.split(path.sep).join('/');
  const rel = norm.replace(`${SRC_DIR.split(path.sep).join('/')}/`, '');
  // 取 src/modules/<module>/ 或 src/platform/<module>/ 下的模块段
  const m = rel.match(/^(?:modules|platform)\/([^/]+)/);
  return m ? m[1] : path.basename(path.dirname(filePath));
}

function parseControllerFile(filePath, registry) {
  const sf = createSource(filePath);
  const moduleName = moduleNameOf(filePath);

  // 先注册文件内的命名类型（interface/type/class）与常量对象（供 typeof 解析）
  const visitDeclarations = (node) => {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      registry.register(node.name.getText(), node, filePath);
    } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      if (isConstObjectDecl(node)) {
        registry.register(node.name.getText(), node, filePath);
      }
    }
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(sf);

  const controllers = [];
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    const decors = getDecorators(stmt);
    const controllerDec = decors.find((d) => decoratorName(d) === 'Controller');
    if (!controllerDec) continue;

    const classGuards = decors.filter((d) => decoratorName(d) === 'UseGuards').flatMap(guardsOf);
    const classDoc = getJSDoc(stmt);
    const prefix = firstStringArg(controllerDec) ?? '';

    const endpoints = [];
    for (const member of stmt.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      const memberDecors = getDecorators(member);
      const methodDec = memberDecors.find((d) => HTTP_METHODS.has(decoratorName(d)));
      if (!methodDec) continue;

      const httpMethod = HTTP_METHODS.get(decoratorName(methodDec));
      const methodPath = firstStringArg(methodDec) ?? '';
      const httpCodeDec = memberDecors.find((d) => decoratorName(d) === 'HttpCode');
      const status = httpCodeDec ? (numericArg(httpCodeDec) ?? 200) : httpMethod === 'post' ? 201 : 200;
      const methodGuards = memberDecors.filter((d) => decoratorName(d) === 'UseGuards').flatMap(guardsOf);
      const guards = [...new Set([...classGuards, ...methodGuards])];
      const doc = getJSDoc(member);

      const params = [];
      const query = [];
      let hasBody = false;
      let bodyTypeName;
      let usesActorDecorator = false;

      for (const param of member.parameters) {
        const paramDecors = getDecorators(param);
        for (const pd of paramDecors) {
          const dn = decoratorName(pd);
          if (dn === 'Param') {
            const name = firstStringArg(pd);
            if (name) params.push({ name, required: true });
          } else if (dn === 'Query') {
            const name = firstStringArg(pd);
            if (name) query.push({ name, required: !param.questionToken });
          } else if (dn === 'Body') {
            hasBody = true;
            const typeRef = param.type && ts.isTypeReferenceNode(param.type) ? param.type.typeName.getText() : undefined;
            bodyTypeName = typeRef;
          } else if (dn === 'Actor' || dn === 'StatisticsActor') {
            // 自定义请求主体装饰器（fail-closed：未接入身份模块时一律 401）
            usesActorDecorator = true;
          }
        }
      }

      endpoints.push({
        httpMethod,
        methodPath,
        status,
        guards,
        usesActorDecorator,
        params,
        query,
        hasBody,
        bodyTypeName,
        summary: doc.summary,
        description: doc.description,
        methodName: member.name.getText(),
      });
    }

    controllers.push({
      className: stmt.name.getText(),
      prefix,
      moduleName,
      guards: classGuards,
      summary: classDoc.summary,
      endpoints,
    });
  }
  return controllers;
}

// ---------------------------------------------------------------------------
// 路径组装与 OpenAPI 文档构建
// ---------------------------------------------------------------------------

function joinPaths(prefix, methodPath) {
  if (methodPath.startsWith('/')) return methodPath; // 方法级绝对路径（如 notification 控制器）
  const parts = [prefix, methodPath].filter((p) => p && p !== '/');
  let joined = '/' + parts.join('/');
  return joined.replace(/\/+/g, '/');
}

/** :clubId → {clubId}；返回 [openapiPath, paramNames[]] */
function toOpenAPIPath(p) {
  const paramNames = [];
  const converted = p.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    paramNames.push(name);
    return `{${name}}`;
  });
  return [converted, paramNames];
}

function buildOperation(controller, ep, registry) {
  const [openapiPath, pathParams] = toOpenAPIPath(joinPaths(controller.prefix, ep.methodPath));
  const operation = {
    operationId: `${controller.className}_${ep.methodName}`,
    summary: ep.summary,
    description: ep.description,
    tags: [controller.moduleName],
  };

  const parameters = [];
  for (const pp of ep.params) {
    parameters.push({
      name: pp.name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: '路径参数',
    });
  }
  // 前缀中的路径参数（如 @Controller('api/org/:clubId/config')）
  for (const pn of pathParams) {
    if (!parameters.some((p) => p.in === 'path' && p.name === pn)) {
      parameters.push({ name: pn, in: 'path', required: true, schema: { type: 'string' } });
    }
  }
  for (const q of ep.query) {
    parameters.push({
      name: q.name,
      in: 'query',
      required: q.required,
      schema: { type: 'string' },
    });
  }
  if (parameters.length) operation.parameters = parameters;

  if (ep.guards.length > 0 || ep.usesActorDecorator) {
    operation.security = [{ bearerAuth: [] }];
  }

  // 请求体：统一信封；命名 DTO 时引用其组件 Schema
  if (ep.hasBody) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema:
            ep.bodyTypeName && registry.map.has(ep.bodyTypeName)
              ? registry.resolve(ep.bodyTypeName, 0)
              : { $ref: '#/components/schemas/ApiRequestEnvelope' },
        },
      },
    };
  }

  // 响应：成功信封 + 通用错误
  operation.responses = {
    [ep.status]: {
      description: '成功（统一成功信封，code 恒为 0）',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ApiSuccess' },
        },
      },
    },
    '400': { $ref: '#/components/responses/BadRequest' },
    '401': { $ref: '#/components/responses/Unauthorized' },
    '403': { $ref: '#/components/responses/Forbidden' },
    '404': { $ref: '#/components/responses/NotFound' },
    '409': { $ref: '#/components/responses/Conflict' },
    '422': { $ref: '#/components/responses/Unprocessable' },
    '500': { $ref: '#/components/responses/InternalError' },
  };

  return [openapiPath, operation];
}

function buildDoc(controllers, registry) {
  const paths = {};
  const tagSet = new Map(); // module → description

  for (const c of controllers) {
    for (const ep of c.endpoints) {
      const [p, op] = buildOperation(c, ep, registry);
      if (!paths[p]) paths[p] = {};
      // 同一路径多方法
      if (paths[p][ep.httpMethod]) {
        console.warn(`[warn] 重复路由 ${ep.httpMethod.toUpperCase()} ${p}（${c.className}.${ep.methodName}）`);
      }
      paths[p][ep.httpMethod] = op;
    }
    if (!tagSet.has(c.moduleName)) {
      tagSet.set(c.moduleName, c.summary ?? `${c.moduleName} 模块接口`);
    }
  }

  const tags = [...tagSet.entries()]
    .map(([name, description]) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const doc = {
    openapi: '3.0.3',
    info: {
      title: 'RanaMinder 后端 API',
      version: 'dev',
      description:
        '高校学生社团人员管理系统 · 后端 HTTP 接口（NestJS）。\n\n' +
        '## 通用约定\n' +
        '- 成功响应统一信封 `ApiSuccess`：`{ "code": 0, "data": ... }`，`code` 恒为 0。\n' +
        '- 失败响应统一 `ApiError`：仅含 `code/message/supportId/fieldErrors`（IFC-ERR-001~017）。\n' +
        '- POST/PUT/DELETE 请求体统一信封 `ApiRequestEnvelope`：顶层仅 `action/targetId/expectedVersion/idempotencyKey/input` 五键，业务字段位于 `input` 内。\n' +
        '- 文件上传例外：`POST /api/files/upload` 为 FormData 直传，无信封。\n' +
        '- 认证：除公开端点外均需 `Authorization: Bearer <token>`（会话令牌）。\n' +
        '- 权威契约：`docs/specification/接口清单-HTTP端点-v1.0.md`、`docs/specification/接口契约-v1.0.md`。\n' +
        '- 本文件由 `node scripts/generate-openapi.js` 生成，勿手工编辑。',
    },
    servers: [
      { url: 'http://localhost:3000', description: '本地开发环境' },
      { url: 'http://localhost:8080', description: 'Docker 开发环境（docker-compose.dev.yml）' },
    ],
    tags,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: '登录后由 /api/auth/session 建立会话，请求头携带 Authorization: Bearer <token>。',
        },
      },
      schemas: {
        ApiSuccess: {
          type: 'object',
          description: '统一成功响应信封（code 恒为 0）',
          required: ['code', 'data'],
          properties: {
            code: { type: 'integer', const: 0 },
            data: { description: '业务数据（各端点返回结构不同）' },
          },
        },
        ApiError: {
          type: 'object',
          description: '统一失败响应信封（API-GEN-004/005），仅允许以下字段',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', description: '错误码 IFC-ERR-001~017' },
            message: { type: 'string', description: '脱敏后的错误信息' },
            supportId: { type: 'string', description: '支持编号（用于日志定位）' },
            fieldErrors: {
              type: 'array',
              description: '字段级校验错误（可选）',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        ApiRequestEnvelope: {
          type: 'object',
          description: '统一请求信封（API-GEN-003）：顶层仅五键，业务字段位于 input 内',
          properties: {
            action: { type: 'string', description: '可选，业务动作标识' },
            targetId: { type: 'string', description: '可选，目标对象稳定标识（服务端回源验证）' },
            expectedVersion: { type: 'number', description: '可选，乐观锁期望版本（不匹配 → 409 IFC-ERR-008）' },
            idempotencyKey: { type: 'string', description: '可选，业务幂等键（同键异参 → 409 IFC-ERR-009）' },
            input: { description: '业务字段（只读）' },
          },
        },
        ...registry.toComponents(),
      },
      responses: {
        BadRequest: {
          description: '请求体解析失败 / 参数校验失败（IFC-ERR-017 等）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Unauthorized: {
          description: '未认证或会话失效（IFC-ERR-001/002）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Forbidden: {
          description: '无权限（IFC-ERR-003/004/011）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        NotFound: {
          description: '资源不存在（IFC-ERR-015）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Conflict: {
          description: '状态冲突 / 幂等冲突 / 版本不匹配（IFC-ERR-007~010）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Unprocessable: {
          description: '业务校验失败（IFC-ERR-005/006）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        InternalError: {
          description: '服务异常（IFC-ERR-016）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  };
  return doc;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const registry = new TypeRegistry();

  // 注册 common/contracts 全部类型
  for (const f of fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.ts'))) {
    const sf = createSource(path.join(CONTRACTS_DIR, f));
    const visit = (node) => {
      if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name
      ) {
        registry.register(node.name.getText(), node, path.join(CONTRACTS_DIR, f));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // 解析全部控制器
  const files = walk(SRC_DIR).sort();
  const controllers = [];
  for (const f of files) {
    try {
      controllers.push(...parseControllerFile(f, registry));
    } catch (err) {
      console.error(`[error] 解析失败 ${f}: ${err.message}`);
    }
  }

  // 兜底：让所有引用的命名类型进入 schemaCache（resolve 会注册）
  const doc = buildDoc(controllers, registry);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const yamlPath = path.join(OUT_DIR, 'openapi.yaml');
  const jsonPath = path.join(OUT_DIR, 'openapi.json');
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2), 'utf8');

  const endpointCount = Object.values(doc.paths).reduce(
    (acc, ops) => acc + Object.keys(ops).filter((m) => m !== 'parameters').length,
    0,
  );
  console.log(`✔ 控制器文件：${files.length}`);
  console.log(`✔ 控制器类：${controllers.length}`);
  console.log(`✔ 路径条目：${Object.keys(doc.paths).length}`);
  console.log(`✔ 端点总数：${endpointCount}`);
  console.log(`✔ 组件 Schema：${Object.keys(doc.components.schemas).length}`);
  console.log(`✔ 输出：${yamlPath}`);
  console.log(`✔ 输出：${jsonPath}`);
}

main();
