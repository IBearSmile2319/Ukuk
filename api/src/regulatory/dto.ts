import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ENTITY_TYPES, EntityType } from '../tenancy/tenant';
import { REG_TOPICS, RegTopic } from './classifier';
import { NORM_SOURCES, NormSource } from './sources/source-adapter';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ArticleDto {
  @IsString() @MaxLength(40) number: string;
  @IsString() @MaxLength(50_000) text: string;
}

/** Norma ingresada a mano (o desde un adaptador). Los campos opcionales se infieren. */
export class NormInputDto {
  @IsIn(NORM_SOURCES) source: NormSource;
  @IsString() @Length(1, 200) external_id: string;
  @IsOptional() @IsString() @MaxLength(300) issuer?: string;
  @IsOptional() @IsString() @MaxLength(200) number?: string;
  @IsString() @Length(3, 2000) title: string;
  @IsOptional() @IsString() @MaxLength(5000) summary?: string;
  @Matches(DATE) published_at: string;
  @IsOptional() @Matches(DATE) effective_at?: string;
  @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @IsOptional() @IsString() @MaxLength(2000) pdf_url?: string;
  @IsOptional() @IsString() @MaxLength(2_000_000) text?: string;
  @IsOptional() @IsIn(['general', 'particular']) scope?: 'general' | 'particular';
  @IsOptional() @IsIn(['vigente', 'proyecto']) status?: 'vigente' | 'proyecto';
  @IsOptional() @Matches(DATE) comments_deadline?: string;
  @IsOptional() @IsArray() @IsIn(ENTITY_TYPES, { each: true }) entity_types?: EntityType[];
  @IsOptional() @IsArray() @IsIn(REG_TOPICS, { each: true }) topics?: RegTopic[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ArticleDto) articles?: ArticleDto[];
}

export class IngestNormsDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => NormInputDto) norms: NormInputDto[];
}

export class RunIngestDto {
  @IsOptional() @Matches(DATE) since?: string;
}

export class NormsQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsIn(REG_TOPICS) topic?: RegTopic;
  @IsOptional() @IsIn(['general', 'particular']) scope?: 'general' | 'particular';
  @IsOptional() @IsIn(['vigente', 'proyecto']) status?: 'vigente' | 'proyecto';
  @IsOptional() @IsIn(NORM_SOURCES) source?: NormSource;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export const PROCESS_KINDS = ['politica', 'proceso', 'manual', 'procedimiento'] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

export class ProcessDto {
  @IsString() @Length(1, 60) code: string;
  @IsString() @Length(2, 300) name: string;
  @IsIn(PROCESS_KINDS) kind: ProcessKind;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsEmail() owner_email?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(30) topics?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(100) keywords?: string[];
}

export class UpdateProcessDto {
  @IsOptional() @IsString() @Length(2, 300) name?: string;
  @IsOptional() @IsIn(PROCESS_KINDS) kind?: ProcessKind;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsEmail() owner_email?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(30) topics?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(100) keywords?: string[];
}

export class CsvImportDto {
  /** Columnas: code,name,kind,description,owner_email,topics,keywords (listas separadas por |). */
  @IsString() @Length(1, 5_000_000) csv: string;
}

export const IMPACT_STATUSES = ['pendiente', 'no_aplica', 'en_adecuacion', 'adecuado'] as const;
export type ImpactStatus = (typeof IMPACT_STATUSES)[number];

export class UpdateImpactDto {
  @IsIn(IMPACT_STATUSES) status: ImpactStatus;
  @IsOptional() @IsString() @MaxLength(5000) note?: string;
}

export class MatrixQueryDto {
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
  @IsOptional() @IsIn(IMPACT_STATUSES) status?: ImpactStatus;
  @IsOptional() @IsUUID() norm_id?: string;
  @IsOptional() @IsString() process_code?: string;
}

export const TASK_STATUSES = ['abierta', 'en_progreso', 'cerrada'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export class CreateTaskDto {
  @IsUUID() impact_id: string;
  @IsString() @Length(3, 500) title: string;
  @IsEmail() responsible_email: string;
  @IsDateString() due_at: string;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @Length(3, 500) title?: string;
  @IsOptional() @IsEmail() responsible_email?: string;
  @IsOptional() @IsDateString() due_at?: string;
  @IsOptional() @IsIn(TASK_STATUSES) status?: TaskStatus;
  @IsOptional() @IsString() @MaxLength(20_000) evidence?: string;
}

export class TasksQueryDto {
  @IsOptional() @IsIn(TASK_STATUSES) status?: TaskStatus;
  @IsOptional() @IsEmail() responsible_email?: string;
  @IsOptional() @IsIn(['true', 'false']) overdue?: 'true' | 'false';
}
