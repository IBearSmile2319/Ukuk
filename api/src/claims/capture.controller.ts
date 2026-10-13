import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CAPTURE_HEADERS, captureErrorPage, capturePage } from './capture-page';
import { CaptureService } from './capture.service';
import { CaptureUploadDto } from './dto';

/** Página pública de captura en vivo. La autorización es el token firmado del enlace. */
@Controller('capture')
export class CaptureController {
  constructor(private readonly capture: CaptureService) {}

  @Get(':token')
  async page(@Param('token') token: string, @Res() res: Response) {
    for (const [k, v] of Object.entries(CAPTURE_HEADERS)) res.setHeader(k, v);
    try {
      const { tenant, claim } = await this.capture.open(token);
      res.status(200).send(capturePage({ claimNumber: claim.number, insurer: tenant.name }));
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      const message = err instanceof HttpException ? err.message : 'Error inesperado';
      res.status(status).send(captureErrorPage('No se puede abrir el enlace', message));
    }
  }

  @Post(':token/photos')
  @HttpCode(201)
  upload(@Param('token') token: string, @Body() dto: CaptureUploadDto) {
    return this.capture.upload(token, dto.photos);
  }
}
