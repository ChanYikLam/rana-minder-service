/**
 * 联合配置端口（joint 应用层；3.x 配置中心接入前的失败关闭桩）。
 */

export interface JointConfigPort {
  /** 读取联合模块运行期配置（如截止默认时长等）。 */
  get(key: string): Promise<unknown>;
}

export class NotWiredJointConfig implements JointConfigPort {
  async get(): Promise<unknown> {
    return null;
  }
}
