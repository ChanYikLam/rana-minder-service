import { Global, Module } from '@nestjs/common';
import { ErrorFormatter } from './errors/error-formatter';

/**
 * 公共组件（错误定义、枚举常量、校验原语，无外部依赖）。
 */
@Global()
@Module({
  providers: [ErrorFormatter],
  exports: [ErrorFormatter],
})
export class CommonModule {}
