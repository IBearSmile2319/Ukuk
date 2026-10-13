/** Borrador de comentarios a un proyecto de norma, sin LLM (plantilla estructurada). */

export interface DraftImpact {
  process_code: string;
  process_name: string;
  articles: { number: string; excerpt: string }[];
}

export interface DraftInput {
  tenantName: string;
  norm: { number: string | null; title: string; comments_deadline: string | null; text?: string | null };
  impacts: DraftImpact[];
}

export function commentsEmail(text: string | null | undefined): string | null {
  return /[\w.+-]+@sbs\.gob\.pe/i.exec(text ?? '')?.[0] ?? null;
}

export function templateCommentDraft(input: DraftInput): string {
  const { norm, impacts } = input;
  const ref = norm.number ? `${norm.number} — ${norm.title}` : norm.title;
  const lines = [
    `# Comentarios de ${input.tenantName} al proyecto: ${ref}`,
    '',
    norm.comments_deadline ? `Plazo para enviar comentarios: ${norm.comments_deadline}.` : 'Plazo para enviar comentarios: revisar el proyecto.',
  ];
  const email = commentsEmail(norm.text);
  if (email) lines.push(`Enviar a: ${email}.`);
  lines.push('', '## Comentarios por artículo', '');
  const byArticle = new Map<string, { excerpt: string; processes: string[] }>();
  for (const i of impacts) {
    for (const a of i.articles) {
      const e = byArticle.get(a.number) ?? { excerpt: a.excerpt, processes: [] };
      e.processes.push(`${i.process_code} ${i.process_name}`);
      byArticle.set(a.number, e);
    }
  }
  if (!byArticle.size) {
    lines.push('No se identificaron artículos que afecten el inventario de procesos registrado.');
  }
  for (const [num, e] of byArticle) {
    lines.push(
      `### Artículo ${num}`,
      `> ${e.excerpt}`,
      '',
      `Procesos afectados: ${e.processes.join('; ')}.`,
      '',
      'Comentario propuesto: [Describir el impacto operativo y el costo de implementación para la entidad].',
      'Propuesta de redacción: [Texto alternativo sugerido].',
      'Plazo de adecuación sugerido: [p. ej., 180 días calendario desde la publicación].',
      '',
    );
  }
  lines.push('## Comentario general', '', '[Opinión general de la entidad sobre el proyecto y su proporcionalidad].');
  return lines.join('\n');
}
