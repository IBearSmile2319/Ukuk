import { Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config/config';

export const LLM_MODEL = 'claude-opus-5-5';

export interface StructuredRequest<T extends z.ZodType> {
  system: string;
  prompt: string;
  schema: T;
  /** low para clasificación de alto volumen; medium/high para análisis. */
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

/**
 * Envoltorio de Claude. El modelo solo interpreta mediciones y redacta: nunca toma
 * la decisión final. Si no hay ANTHROPIC_API_KEY, `enabled` es false y los módulos
 * usan su versión determinista.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client?: Anthropic;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.anthropicApiKey) this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  get enabled(): boolean {
    return !!this.client;
  }

  /** Devuelve null si el servicio está desactivado, falla o el modelo declina. */
  async structured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T> | null> {
    if (!this.client) return null;
    try {
      const response = await this.client.beta.messages.parse({
        model: LLM_MODEL,
        max_tokens: req.maxTokens ?? 16000,
        // Si el modelo declina por política, la API reintenta con el modelo de respaldo.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        output_config: { effort: req.effort ?? 'medium', format: betaZodOutputFormat(req.schema) },
      });
      if (response.stop_reason === 'refusal') {
        this.logger.warn(`El modelo declinó: ${response.stop_details?.category ?? 'sin categoría'}`);
        return null;
      }
      return (response.parsed_output as z.infer<T> | null) ?? null;
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        this.logger.warn('Límite de tasa de Claude; se usa la versión determinista');
      } else if (error instanceof Anthropic.APIError) {
        this.logger.error(`Error de Claude ${error.status}: ${error.message}`);
      } else {
        this.logger.error(`Error al llamar a Claude: ${(error as Error).message}`);
      }
      return null;
    }
  }
}
