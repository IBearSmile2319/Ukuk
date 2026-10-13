import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
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

export const CLAIM_STATUSES = [
  'borrador',
  'cancelado',
  'revision_analista',
  'ajustador',
  'aclaracion',
  'aprobado',
  'rechazado',
  'consentido',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export class ClaimsQueryDto {
  @IsOptional() @IsIn(CLAIM_STATUSES) status?: ClaimStatus;
  @IsOptional() @IsIn(['bajo', 'medio', 'alto']) risk?: 'bajo' | 'medio' | 'alto';
  /** Casos abiertos cuyo plazo de 30 días vence dentro de N días. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60) due_within_days?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class ReviewDto {
  @IsIn(['approve_to_adjuster', 'reject', 'request_info']) action: 'approve_to_adjuster' | 'reject' | 'request_info';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class DecisionDto {
  @IsIn(['aprobado', 'rechazado', 'aclaracion']) decision: 'aprobado' | 'rechazado' | 'aclaracion';
  @IsOptional() @IsString() @MaxLength(4000) note?: string;
}

export class PolicyImportDto {
  /** Columnas: policy_number,holder_dni,holder_name,plate,product,line,start,end,notice_days,status */
  @IsString() @Length(1, 20_000_000) csv: string;
  /** Si es true, las pólizas que no vienen en el archivo pasan a status "no_vigente". */
  @IsOptional() @IsBoolean() replace?: boolean;
}

export class RequiredDocDto {
  @Matches(/^[a-z0-9_]{2,40}$/) code: string;
  @IsString() @Length(2, 60) label: string;
  @IsOptional()
  @IsIn(['dni', 'boleta_pago', 'recibo_servicio', 'factura', 'boleta_venta', 'informe_medico', 'receta', 'acta', 'certificado', 'other'])
  engine_type?: any;
}

export class ClaimTypeDto {
  @Matches(/^[a-z0-9_]{2,40}$/) code: string;
  @IsString() @Length(2, 24) label: string;
  @IsIn(['daños', 'personas']) line: 'daños' | 'personas';
  @IsBoolean() photos: boolean;
  @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => RequiredDocDto) required_docs: RequiredDocDto[];
}

export class DestinationDto {
  @IsIn(['none', 'webhook', 'email']) type: 'none' | 'webhook' | 'email';
  @IsOptional() @IsString() @Matches(/^https?:\/\//) url?: string;
  @IsOptional() @IsString() @Length(16, 200) secret?: string;
  @IsOptional() @IsArray() @IsEmail({}, { each: true }) to?: string[];
}

export class PolicySourceDto {
  @IsIn(['csv', 'http']) type: 'csv' | 'http';
  @IsOptional() @IsString() @Matches(/^https?:\/\//) url?: string;
  @IsOptional() @IsString() @MaxLength(2000) token?: string;
}

export class ClaimsConfigDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(9) @ValidateNested({ each: true }) @Type(() => ClaimTypeDto)
  claim_types?: ClaimTypeDto[];
  @IsOptional() @IsObject() @ValidateNested() @Type(() => DestinationDto) destination?: DestinationDto;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => PolicySourceDto) policy_source?: PolicySourceDto;
  @IsOptional() @IsNumber() @Min(0.1) @Max(500) gps_max_km?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1440) max_clock_drift_minutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(24) capture_ttl_hours?: number;
  @IsOptional() @IsInt() @Min(10) @Max(100) max_inbound_messages?: number;
}

export class CapturePhotoDto {
  @IsString() @MaxLength(11_000_000) image_base64: string;
  @IsIn(['image/jpeg', 'image/png', 'image/webp']) mime_type: string;
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @IsNumber() @Min(0) accuracy?: number;
  /** Hora del celular al tomar la foto (ISO). */
  @IsOptional() @IsDateString() captured_at?: string;
}

export class CaptureUploadDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => CapturePhotoDto) photos: CapturePhotoDto[];
}

export class WhatsAppNumberDto {
  @IsUUID() tenant_id: string;
  @Matches(/^\d{5,30}$/) phone_number_id: string;
  @Matches(/^\+?\d{8,15}$/) display_number: string;
  @IsOptional() @IsString() @MaxLength(2000) access_token?: string;
  /** Nombre de la variable de entorno/secreto con el token, en lugar de guardarlo. */
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{2,100}$/) secret_ref?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
