/**
 * 组织与授权模块 · HTTP 入参 DTO（class-validator 校验，Nest ValidationPipe 生效）。
 *
 * 事实基线：docs/specification/接口清单-HTTP端点-v1.0.md §15.1/15.2/15.3、§4/5
 * org 域路由；错误码语义（IFC-ERR-*）见 docs/specification/接口契约-v1.0.md。
 */

import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// --------------------------------------------------------------------------
// 社团接入（§15.1）
// --------------------------------------------------------------------------

export class WizardCreateDto {
  @IsString() @IsNotEmpty() groupId!: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsOptional() description!: string;
  @IsString() @IsNotEmpty() leaderGroupId!: string;
  @IsEmail() @IsOptional() email!: string;
  @IsArray() @IsString({ each: true }) @IsOptional() departmentGroupIds!: string[];
  @IsArray() @IsString({ each: true }) @IsOptional() positionGroupIds!: string[];
  @IsString() @IsOptional() leaderRoleGroupId!: string;
  @IsString() @IsOptional() reauthProof!: string;
}

export class WizardSaveStepDto {
  @IsString() @IsNotEmpty() clubId!: string;
  @IsString() @IsOptional() step!: string;
  @IsString() @IsOptional() name!: string;
  @IsEmail() @IsOptional() email!: string;
}

export class WizardCompleteDto {
  @IsString() @IsNotEmpty() clubId!: string;
  @IsBoolean() confirmed!: boolean;
}

export class ImportMembersDto {
  @IsArray() @IsString({ each: true }) memberIds!: string[];
}

export class SuspensionDto {
  @IsString() @IsNotEmpty() reason!: string;
  @IsBoolean() @IsOptional() confirmed!: boolean;
}

export class RebindDto {
  @IsString() @IsNotEmpty() groupId!: string;
  @IsBoolean() confirmed!: boolean;
}

export class ReaccessDto {
  @IsString() @IsNotEmpty() groupId!: string;
  @IsBoolean() confirmed!: boolean;
}

export class ConfirmedActionDto {
  @IsBoolean() @IsOptional() confirmed!: boolean;
}

// --------------------------------------------------------------------------
// 权限模板（§15.3）
// --------------------------------------------------------------------------

export class TemplateCreateDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsArray() @IsString({ each: true }) permissions!: string[];
}

export class TemplateSaveDraftDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsArray() @IsString({ each: true }) permissions!: string[];
}

export class TemplatePublishDto {
  @IsString() @IsNotEmpty() reauthProof!: string;
  @Min(0) previewVersion!: number;
  @IsString() @IsNotEmpty() reason!: string;
}

// --------------------------------------------------------------------------
// 关系命令（org 域）
// --------------------------------------------------------------------------

export class TargetGroupDto {
  @IsObject() ref!: { owner: string; name: string };
  @IsIn(['add', 'remove']) kind!: 'add' | 'remove';
}

export class SubmitRelationCommandDto {
  @IsString() @IsNotEmpty() type!: string;
  @IsString() @IsNotEmpty() subjectId!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TargetGroupDto)
  targetGroups!: TargetGroupDto[];
  @Min(0) objectVersion!: number;
  @IsString() @IsNotEmpty() idempotencyKey!: string;
}

// --------------------------------------------------------------------------
// 预约命令（org 域）
// --------------------------------------------------------------------------

export class CreateAppointmentCommandDto {
  @IsString() @IsNotEmpty() type!: 'appoint' | 'revoke' | 'transfer';
  @IsString() @IsNotEmpty() subjectId!: string;
  @IsString() @IsOptional() departmentGroupId!: string;
  @IsString() @IsOptional() positionGroupId!: string;
  @IsString() @IsOptional() revokeFromGroupId!: string;
  @IsString() @IsNotEmpty() plannedAt!: string;
}

export class ReconfirmAppointmentDto {
  @IsString() @IsOptional() newExecTime!: string;
}

export class CancelCommandDto {
  @IsString() @IsNotEmpty() reason!: string;
}
