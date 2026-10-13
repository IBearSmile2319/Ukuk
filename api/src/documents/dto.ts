import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsJSON,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { DocumentType } from '../engine/engine.types';

export const DOCUMENT_TYPES: DocumentType[] = [
  'dni',
  'boleta_pago',
  'recibo_servicio',
  'factura',
  'boleta_venta',
  'informe_medico',
  'receta',
  'acta',
  'certificado',
  'other',
];
export const LEVELS = ['extraction', 'verification', 'forensic'] as const;
export type Level = (typeof LEVELS)[number];
export const VERDICTS = ['aprobar', 'revisar', 'rechazar'] as const;
export const REVIEW_DECISIONS = ['aprobado', 'rechazado', 'legitimo'] as const;

/** Campos del formulario multipart (todos llegan como texto). */
export class UploadDocumentDto {
  @IsOptional() @IsIn(DOCUMENT_TYPES) document_type?: DocumentType;
  @IsOptional() @IsIn(LEVELS) level?: Level;
  @IsOptional() @IsJSON({ message: 'fields debe ser un objeto JSON' }) fields?: string;
  @IsOptional() @IsString() @Length(1, 200) external_ref?: string;
  @IsOptional() @IsString() @Length(1, 200) issuer?: string;
}

export class ListDocumentsQuery {
  @IsOptional() @IsIn(VERDICTS) verdict?: string;
  @IsOptional() @IsIn(['processing', 'completed', 'failed']) status?: string;
  @IsOptional() @IsIn(DOCUMENT_TYPES) document_type?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class ReviewDto {
  @IsIn(REVIEW_DECISIONS) decision: (typeof REVIEW_DECISIONS)[number];
  @IsOptional() @IsString() @Length(0, 4000) notes?: string;
  /** Quién decide (usuario del sistema del cliente), para la auditoría. */
  @IsOptional() @IsString() @Length(1, 200) analyst?: string;
  @IsOptional() @IsBoolean() add_to_templates?: boolean;
}

export class BboxDto {
  @IsNumber() @Min(0) @Max(1) x: number;
  @IsNumber() @Min(0) @Max(1) y: number;
  @IsNumber() @Min(0) @Max(1) w: number;
  @IsNumber() @Min(0) @Max(1) h: number;
}

export class AnchorDto {
  @IsString() @Length(1, 200) text: string;
  @ValidateNested() @Type(() => BboxDto) bbox: BboxDto;
}

class TemplateBaseDto {
  @IsIn(DOCUMENT_TYPES) document_type: DocumentType;
  @IsString() @Length(1, 200) issuer: string;
  @IsString() @Length(1, 200) version_label: string;
  @IsDateString() valid_from: string;
  @IsOptional() @IsDateString() valid_to?: string;
  @IsOptional() @IsNumber() @Min(0.001) @Max(0.5) tolerance?: number;
}

export class CreateTemplateDto extends TemplateBaseDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => AnchorDto)
  anchors: AnchorDto[];
}

export class TemplateFromSamplesDto extends TemplateBaseDto {
  /** Documentos legítimos de muestra; si se omite, se usan los marcados como muestra para ese tipo y emisor. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) document_ids?: string[];
  @IsOptional() @IsNumber() @Min(0.1) @Max(1) min_presence?: number;
}

export class ListTemplatesQuery {
  @IsOptional() @IsIn(DOCUMENT_TYPES) document_type?: string;
  @IsOptional() @IsString() @Length(1, 200) issuer?: string;
}

export const normalizeIssuer = (s: string) => s.trim().toLowerCase();
export const actorOf = (analyst?: string) => (analyst ? `analyst:${analyst}` : 'api');
