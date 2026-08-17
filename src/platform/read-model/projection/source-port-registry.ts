import { Injectable } from '@nestjs/common';
import type { AuthoritativeSourcePort } from '../contracts';

/**
 * 权威源端口注册表（只读领域权威对象）。
 *
 * 由各领域模块（identity/organization/recruitment/joint 等）在实现后
 * 调用 register() 注入其只读端口；read-model 只经端口读取，
 * 绝不写入领域状态。未注册的领域对象类型视为"源不可用"，
 * 投影按明确不可用处理（不伪造新鲜结果，IFC-QRY-009.8）。
 */
@Injectable()
export class SourcePortRegistry {
  private readonly ports = new Map<string, AuthoritativeSourcePort>();

  register(port: AuthoritativeSourcePort): void {
    this.ports.set(port.objectType, port);
  }

  get(objectType: string): AuthoritativeSourcePort | null {
    return this.ports.get(objectType) ?? null;
  }

  list(): readonly AuthoritativeSourcePort[] {
    return [...this.ports.values()];
  }
}
