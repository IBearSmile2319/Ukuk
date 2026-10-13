import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiKeyGuard, CurrentTenant, RequireModule } from '../tenancy/guards';
import { Tenant } from '../tenancy/tenant';
import { DocumentsService, IncomingFile, MAX_FILE_BYTES } from './documents.service';
import {
  CreateTemplateDto,
  ListDocumentsQuery,
  ListTemplatesQuery,
  ReviewDto,
  TemplateFromSamplesDto,
  UploadDocumentDto,
  actorOf,
} from './dto';
import { TemplatesService } from './templates.service';

/** Biblioteca de plantillas. Se registra antes que DocumentsController para que /templates no choque con /:id. */
@Controller('v1/documents/templates')
@UseGuards(ApiKeyGuard)
@RequireModule('documents')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentTenant() t: Tenant, @Query() q: ListTemplatesQuery) {
    return this.templates.list(t, q);
  }

  @Post()
  create(@CurrentTenant() t: Tenant, @Body() dto: CreateTemplateDto) {
    return this.templates.create(t, dto);
  }

  @Post('from-samples')
  fromSamples(@CurrentTenant() t: Tenant, @Body() dto: TemplateFromSamplesDto) {
    return this.templates.fromSamples(t, dto);
  }

  @Delete(':id')
  remove(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.remove(t, id);
  }
}

@Controller('v1/documents')
@UseGuards(ApiKeyGuard)
@RequireModule('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } }))
  upload(
    @CurrentTenant() t: Tenant,
    @UploadedFile() file: IncomingFile | undefined,
    @Body() dto: UploadDocumentDto,
  ) {
    return this.documents.analyze(t, file, dto);
  }

  @Get()
  list(@CurrentTenant() t: Tenant, @Query() q: ListDocumentsQuery) {
    return this.documents.list(t, q);
  }

  @Get(':id')
  get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(t, id);
  }

  @Get(':id/file')
  async file(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const { meta, data } = await this.documents.file(t, id);
    const name = (meta.filename ?? `documento-${id}`).replace(/[^\w.\- ]/g, '_');
    return new StreamableFile(data, {
      type: meta.mimeType,
      length: data.length,
      disposition: `inline; filename="${name}"`,
    });
  }

  @Post(':id/review')
  review(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto) {
    return this.documents.review(t, id, dto, actorOf(dto.analyst));
  }
}
