import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { DOC_TYPES, DocType, KINDS, Kind, RELATIONS, Relation } from './regime';

export const CASE_DECISIONS = ['falso_positivo', 'coincidencia_confirmada', 'escalado_uif'] as const;
export type CaseDecision = (typeof CASE_DECISIONS)[number];
export const REGIMES = ['simplificado', 'general', 'reforzado'] as const;

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class CreateSubjectDto {
  @IsIn(RELATIONS) relation: Relation;
  @IsIn(KINDS) kind: Kind;
  @IsString() @Length(2, 300) name: string;
  @Transform(upper) @IsIn(DOC_TYPES) doc_type: DocType;
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s/g, '').toUpperCase() : value))
  @IsString()
  @Length(1, 20)
  doc_number: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birth_date debe tener el formato AAAA-MM-DD' }) @IsDateString() birth_date?: string;
  @IsOptional() @Transform(upper) @IsString() @Length(2, 3) nationality?: string;
  @IsOptional() @IsBoolean() monitor?: boolean;
  @IsOptional() @IsString() @Length(1, 200) analyst?: string;
}

export class ListSubjectsQuery {
  @IsOptional() @IsIn(RELATIONS) relation?: string;
  @IsOptional() @IsIn(REGIMES) regime?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() monitor?: boolean;
  @IsOptional() @IsString() @Length(1, 200) q?: string;
  /** Sujetos cuya próxima revisión vence dentro de N días. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650) due_within_days?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class BulkSubjectsDto {
  /** Valor por defecto de monitor para filas sin esa columna. */
  @IsOptional() @Transform(toBool) @IsBoolean() monitor?: boolean;
  @IsOptional() @IsString() @Length(1, 200) analyst?: string;
}

export class ListCasesQuery {
  @IsOptional() @IsIn(['abierto', 'cerrado']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class DecisionDto {
  @IsIn(CASE_DECISIONS) decision: CaseDecision;
  @IsString()
  @Length(20, 8000, { message: 'El sustento (rationale) debe tener al menos 20 caracteres' })
  rationale: string;
  @IsOptional() @IsString() @Length(1, 200) analyst?: string;
}

export class ReportQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class WatchlistUploadQuery {
  @IsIn(['ofac_sdn_csv', 'un_xml', 'ukuk_jsonl']) format: 'ofac_sdn_csv' | 'un_xml' | 'ukuk_jsonl';
  @IsOptional() @IsIn(['sanction', 'pep', 'interest']) category?: 'sanction' | 'pep' | 'interest';
  @IsOptional() @Transform(toBool) @IsBoolean() rescreen?: boolean;
}

export class SyncQuery {
  @IsOptional() @Transform(toBool) @IsBoolean() rescreen?: boolean;
}

export class BillingQuery {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month debe ser AAAA-MM' }) month: string;
}

export const actorOf = (analyst?: string) => (analyst ? `analyst:${analyst}` : 'api');
