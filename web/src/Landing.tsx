import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DocReport } from './api';
import { Inspector, buildMarks, orderFindings } from './Inspector';
import { FieldsTable, FindingsList } from './Report';
import { Bear, ENTITY_TYPES, MODULES, ScoreScale, Wordmark } from './ui';

const SAMPLES = [
  { id: 'boleta-legitima', title: 'Boleta de venta', note: 'Clínica en Miraflores, tal como se emitió', ratio: 1754 / 1240 },
  { id: 'boleta-adulterada', title: 'La misma boleta, retocada', note: 'Alguien cambió un monto', ratio: 1754 / 1240 },
  { id: 'dni-especimen', title: 'DNIe con número cambiado', note: 'Espécimen con datos ficticios', ratio: 638 / 1012 },
  { id: 'dni-azul-especimen', title: 'DNI azul vencido', note: 'La versión anterior, ya caducada', ratio: 638 / 1012 },
] as const;

type SampleId = (typeof SAMPLES)[number]['id'];

function useSample(id: SampleId | null) {
  const [report, setReport] = useState<DocReport | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setReport(null);
    fetch(`/demo/${id}.json`)
      .then((r) => r.json())
      .then((r: DocReport) => live && setReport({ ...r, findings: orderFindings(r.findings) }));
    return () => {
      live = false;
    };
  }, [id]);
  return report;
}

const scrollToSection = (id: string) => {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
};

export function Landing({ section }: { section: string }) {
  useEffect(() => {
    if (section) scrollToSection(section);
    else window.scrollTo(0, 0);
  }, [section]);
  useEffect(() => {
    document.title = 'ukuk — antifraude documental y cumplimiento para el Perú';
  }, []);

  return (
    <div className="landing">
      <a className="skip" href="#/contacto">
        Ir al formulario de contacto
      </a>
      <header className="l-header">
        <a href="#/" className="l-brand" aria-label="ukuk, inicio">
          <Wordmark size={34} />
        </a>
        <nav aria-label="Secciones" className="l-nav">
          <a href="#/servicios">Servicios</a>
          <a href="#/demo">Demo</a>
          <a href="#/piloto">Piloto</a>
          <a href="#/seguridad">Seguridad</a>
        </nav>
        <div className="l-header-actions">
          <a href="#/app" className="btn btn-quiet">
            Ingresar
          </a>
          <a href="#/contacto" className="btn btn-primary">
            Solicitar un piloto
          </a>
        </div>
      </header>

      <main id="contenido">
        <Hero />
        <div className="escalon" aria-hidden="true" />
        <Services />
        <Demo />
        <Pilot />
        <Security />
        <Contact />
      </main>

      <footer className="l-footer">
        <div>
          <Wordmark size={30} />
          <p>Ukuk significa oso de anteojos en quechua.</p>
        </div>
        <div>
          <p>[RAZÓN SOCIAL]</p>
          <p>RUC [RUC]</p>
          <p>[CORREO DE CONTACTO]</p>
        </div>
        <div>
          <a href="#/app">Ingresar al portal</a>
          <a href="#/contacto">Solicitar un piloto</a>
        </div>
      </footer>
    </div>
  );
}

function Hero() {
  const full = useSample('dni-especimen');
  // En la portada solo lo que pesa en el veredicto; el informe completo está en la demo.
  const report = useMemo(() => (full ? { ...full, findings: full.findings.filter((f) => f.severity !== 'low') } : null), [full]);
  const [done, setDone] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  // La araña empieza a caminar cuando el documento entra en pantalla (en celulares está más abajo).
  const visualRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = visualRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setInView(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setInView(true), io.disconnect()), { threshold: 0.45 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const top = report?.findings.findIndex((f) => f.severity === 'high' || f.severity === 'critical') ?? -1;
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <h1 id="hero-title">Antifraude documental peruano, conectado a las fuentes oficiales.</h1>
        <p className="hero-sub">
          Ukuk revisa DNI, boletas, recibos, facturas e informes médicos. En segundos entrega un puntaje de riesgo, los datos
          extraídos y cada hallazgo marcado sobre el documento. Valida contra SUNAT y, con el convenio de su entidad, contra RENIEC.
        </p>
        <p className="hero-principle">
          El sistema recomienda.
          <br />
          La entidad decide.
        </p>
        <div className="hero-actions">
          <a href="#/contacto" className="btn btn-primary btn-lg">
            Solicitar un piloto
          </a>
          <a href="#/demo" className="btn btn-ghost btn-lg">
            Probar con un documento
          </a>
        </div>
      </div>
      <div className="hero-visual" ref={visualRef}>
        {report && inView ? (
          <Inspector
            src="/demo/dni-especimen.jpg"
            ratio={640 / 1010}
            report={report}
            animate
            active={active}
            onActive={setActive}
            onDone={() => setDone(true)}
            label="DNI de muestra analizado por el inspector de Ukuk"
            tools={false}
          />
        ) : (
          <div className="ins-stage" style={{ aspectRatio: '1010 / 640' }}>
            <img src="/demo/dni-especimen.jpg" alt="" />
          </div>
        )}
        <div className={`hero-callout${done && top >= 0 ? ' is-on' : ''}`} aria-hidden={!done}>
          {report && top >= 0 && (
            <>
              <p>
                <button type="button" className={`fno fno-red${active === top ? ' is-active' : ''}`} onClick={() => setActive(active === top ? null : top)}>
                  {top + 1}
                </button>
                {report.findings[top].message}
              </p>
              <p className="muted">
                Riesgo {report.score} de 100. Ukuk recomienda <strong>revisar</strong>; la decisión es de su analista.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

const LAYERS_COPY: [string, string][] = [
  ['Calidad y legibilidad', 'Foto borrosa, reflejos, esquinas cortadas. Si falla, se pide otra foto.'],
  ['Consistencia interna', 'Sumas que no cuadran, IGV mal calculado, fechas imposibles, MRZ que no coincide con lo impreso.'],
  ['Forense de imagen', 'Tipografía mezclada, letras desalineadas, zonas copiadas y pegadas, compresión distinta en una zona.'],
  ['Plantilla de referencia', 'Logo, posiciones o fuentes que no corresponden al emisor y al año del documento.'],
  ['Validación externa', 'Comprobante inexistente o anulado, RUC dado de baja, clínica no registrada, médico inexistente.'],
  ['Reuso', 'La misma boleta o foto presentada en otro reclamo.'],
];

function Services() {
  return (
    <section id="servicios" className="l-section" aria-labelledby="servicios-title">
      <div className="l-head">
        <h2 id="servicios-title">Cuatro servicios sobre una misma plataforma</h2>
        <p>
          Se contratan por separado y cada uno se activa por contrato. Quien contrata varios obtiene un paquete con descuento.
        </p>
      </div>
      <div className="services">
        <article className="service service-anchor">
          <h3>Verificación documental</h3>
          <p className="service-what">
            Detecta alteraciones, ilegibilidad y DNI falsos; extrae los datos y entrega un informe con cada hallazgo marcado.
            Reconoce las tres versiones vigentes del DNI: el DNIe 3.0, el azul y el amarillo.
          </p>
          <p className="service-who">
            <span>Lo usan</span> equipos de siniestros y reembolsos en seguros, y de créditos y onboarding en bancos, cajas y fintech.
          </p>
          <dl className="layers">
            {LAYERS_COPY.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <p className="service-note">
            Cuando no hay una plantilla del emisor, el informe lo dice: «sin plantilla de referencia, confianza limitada». Es
            mejor que fingir certeza.
          </p>
        </article>
        <div className="service-stack">
          <article className="service">
            <h3>Radar regulatorio</h3>
            <p className="service-what">
              Vigila las normas nuevas de la SBS y El Peruano y le dice qué política, proceso o manual interno impactan, con la
              fecha de vigencia. Crea tareas con responsable y plazo, y redacta un borrador de comentarios para los proyectos de
              norma.
            </p>
            <p className="service-who">
              <span>Lo usan</span> las áreas de cumplimiento normativo y legal de entidades supervisadas por la SBS.
            </p>
          </article>
          <article className="service">
            <h3>PLAFT</h3>
            <p className="service-what">
              Revisa clientes, proveedores, trabajadores y directores contra OFAC, ONU, PEP y listas de la SBS. La búsqueda está
              pensada para nombres peruanos: dos apellidos, tildes, «de la» y errores de tipeo. Revisa la cartera cada noche y
              lleva cada caso con decisión, sustento y registro de auditoría.
            </p>
            <p className="service-who">
              <span>Lo usan</span> oficiales de cumplimiento de sujetos obligados ante la UIF: cooperativas, casas de cambio,
              remesadoras, inmobiliarias, notarías, casinos y más.
            </p>
          </article>
          <article className="service">
            <h3>Siniestros por WhatsApp</h3>
            <p className="service-what">
              El asegurado reporta por chat y toma las fotos con la cámara en vivo, con hora y GPS. Cada foto y documento pasa por
              la verificación documental, y el caso llega completo al ajustador con el plazo SBS corriendo y alertas antes de que
              quede consentido.
            </p>
            <p className="service-who">
              <span>Lo usan</span> aseguradoras medianas, corredores, AFOCAT y bancaseguros.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

function Demo() {
  const [pick, setPick] = useState<SampleId | null>(null);
  const [run, setRun] = useState(0);
  const [done, setDone] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const report = useSample(pick);
  const sample = SAMPLES.find((s) => s.id === pick);
  const marks = useMemo(() => (report ? buildMarks(report.findings, report.ocr?.words ?? []) : []), [report]);

  const choose = (id: SampleId) => {
    setPick(id);
    setRun((n) => n + 1);
    setDone(false);
    setActive(null);
  };

  return (
    <section id="demo" className="l-section demo" aria-labelledby="demo-title">
      <div className="l-head">
        <h2 id="demo-title">Mire cómo se revisa un documento</h2>
        <p>
          Elija un documento de muestra. Los datos son ficticios; el informe es el que devolvió Ukuk al analizarlo. La araña
          recorre el texto que leyó el OCR, marca en azul los datos extraídos y en rojo o ámbar lo que encontró.
        </p>
      </div>
      <div className={`demo-grid${pick ? ' has-doc' : ''}`}>
        <fieldset className="demo-pick">
          <legend className="sr-only">Documento de muestra</legend>
          {SAMPLES.map((s) => (
            <label key={s.id} className={`sample${pick === s.id ? ' is-on' : ''}`}>
              <input type="radio" name="sample" value={s.id} checked={pick === s.id} onChange={() => choose(s.id)} />
              <img src={`/demo/${s.id}.jpg`} alt="" />
              <span>
                <strong>{s.title}</strong>
                <small>{s.note}</small>
              </span>
            </label>
          ))}
          {pick && (
            <button type="button" className="btn btn-ghost-inverse" onClick={() => choose(pick)}>
              Analizar de nuevo
            </button>
          )}
        </fieldset>

        <div className="demo-doc">
          {pick && report && sample ? (
            <Inspector
              key={`${pick}-${run}`}
              src={`/demo/${pick}.jpg`}
              ratio={sample.ratio}
              report={report}
              animate
              active={active}
              onActive={setActive}
              onDone={() => setDone(true)}
              label={`${sample.title}: análisis de muestra`}
            />
          ) : (
            <div className="demo-empty">
              <Bear size={56} inverse />
              <p>Elija un documento para empezar el análisis.</p>
            </div>
          )}
        </div>

        <div className="demo-result" aria-live="polite">
          {pick && report && done && (
            <>
              <ScoreScale score={report.score ?? 0} verdict={report.verdict} />
              {report.confidence_note && <p className="note">Nota del informe: {report.confidence_note}.</p>}
              <h3 className="h-small">Hallazgos</h3>
              <FindingsList findings={report.findings} marks={marks} active={active} onActive={setActive} />
              <h3 className="h-small">Datos extraídos</h3>
              <FieldsTable fields={report.extracted_fields} />
              <p className="muted small">
                En el portal, su analista aprueba, rechaza o marca el documento como legítimo, y esa decisión queda en el registro
                de auditoría.
              </p>
            </>
          )}
          {pick && !done && <p className="demo-wait">El informe aparece cuando el inspector termina.</p>}
        </div>
      </div>
    </section>
  );
}

function Pilot() {
  const steps = [
    ['Meta por escrito', 'Antes de empezar acordamos qué significa éxito: por ejemplo, fraudes detectados u horas de analista ahorradas.'],
    ['Piloto pagado de 60 a 90 días', 'A precio reducido, con sus documentos y sus casos reales, y su equipo usando el portal o la API.'],
    ['Contrato anual', 'Si se cumple la meta, el piloto pasa a contrato anual. Si no, lo sabrá con datos.'],
  ];
  return (
    <section id="piloto" className="l-section" aria-labelledby="piloto-title">
      <div className="l-head">
        <h2 id="piloto-title">Cómo funciona un piloto</h2>
        <p>Empezamos chico, con una meta que se puede medir.</p>
      </div>
      <ol className="stairs">
        {steps.map(([t, d], i) => (
          <li key={t} style={{ ['--step' as string]: i }}>
            <h3>{t}</h3>
            <p>{d}</p>
          </li>
        ))}
      </ol>
      <div className="pilot-needs">
        <h3>Para empezar necesitamos</h3>
        <ul>
          <li>Documentos que su entidad ya aprobó, como punto de partida unos 10 a 30 por emisor y versión, para las plantillas.</li>
          <li>Su convenio con RENIEC, si quiere validar DNI contra la fuente.</li>
          <li>Para siniestros: su número de WhatsApp Business, un archivo diario de pólizas y qué siniestros atenderá el bot.</li>
          <li>Para PLAFT y el radar: su cartera de clientes y proveedores, y su inventario de políticas y procesos.</li>
        </ul>
      </div>
    </section>
  );
}

function Security() {
  const items = [
    ['Datos aislados por cliente', 'Cada entidad solo puede leer sus propios registros; el aislamiento lo impone la base de datos, no solo la aplicación.'],
    ['Cifrado por cliente', 'Los archivos y datos sensibles se cifran con llaves propias de cada entidad.'],
    ['Auditoría a prueba de alteraciones', 'Cada acción queda encadenada con la anterior. Si alguien modifica un registro, la cadena se rompe y se detecta.'],
    ['Región de procesamiento por contrato', 'Procesar datos fuera del Perú requiere autorización previa de la SBS, así que la región se define con cada cliente.'],
    ['Su propio convenio con RENIEC', 'Las consultas usan las credenciales del convenio de su entidad. Ukuk no revende datos de RENIEC.'],
    ['Hallazgos que se pueden auditar', 'Las reglas y mediciones deciden el puntaje. El modelo de lenguaje solo redacta la explicación y nunca cambia el veredicto.'],
  ];
  return (
    <section id="seguridad" className="l-section" aria-labelledby="seguridad-title">
      <div className="l-head">
        <h2 id="seguridad-title">Construido para entidades supervisadas</h2>
        <p>Así está diseñada la plataforma desde el primer día.</p>
      </div>
      <dl className="principles">
        {items.map(([t, d]) => (
          <div key={t}>
            <dt>{t}</dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">
        Son principios de diseño, no certificaciones. Estado de certificaciones (ISO 27001 o SOC 2): [ESTADO DE CERTIFICACIÓN].
      </p>
    </section>
  );
}

const SERVICE_KEYS = ['documents', 'regulatory', 'plaft', 'claims'] as const;

function Contact() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const body: Record<string, unknown> = {
      name: text('name'),
      company: text('company'),
      email: text('email'),
      website: text('website'),
    };
    if (text('phone')) body.phone = text('phone');
    if (text('entity_type')) body.entity_type = text('entity_type');
    const services = f.getAll('services').map(String);
    if (services.length) body.services = services;
    if (text('message')) body.message = text('message');
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/public/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        const m = String(Array.isArray(b?.message) ? b.message.join(' ') : (b?.message ?? ''));
        throw new Error(
          res.status === 400
            ? /email/i.test(m)
              ? 'Revise el correo: no parece válido.'
              : 'Revise los datos: el nombre y la empresa necesitan al menos 2 caracteres.'
            : 'No pudimos enviar su solicitud. Intente de nuevo en unos minutos o escríbanos a [CORREO DE CONTACTO].',
        );
      }
      setEmail(String(body.email));
      setState('sent');
    } catch (err) {
      setError(err instanceof TypeError ? 'No se pudo conectar. Revise su conexión e intente de nuevo.' : (err as Error).message);
      setState('idle');
    }
  };

  return (
    <section id="contacto" className="l-section contact" aria-labelledby="contacto-title">
      <div className="contact-copy">
        <h2 id="contacto-title">Solicitar un piloto</h2>
        <p>
          Cuéntenos qué quiere resolver y con qué volumen trabaja. Le escribiremos para acordar la meta del piloto. Si prefiere,
          escríbanos a [CORREO DE CONTACTO].
        </p>
      </div>
      {state === 'sent' ? (
        <div className="contact-done" role="status">
          <h3>Recibimos su solicitud</h3>
          <p>Le escribiremos a {email} para coordinar. Gracias por su interés en Ukuk.</p>
        </div>
      ) : (
        <form className="form contact-form" onSubmit={submit} noValidate={false}>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Nombre y apellido</span>
              <input name="name" required minLength={2} maxLength={120} autoComplete="name" />
            </label>
            <label className="field">
              <span className="field-label">Empresa</span>
              <input name="company" required minLength={2} maxLength={200} autoComplete="organization" />
            </label>
            <label className="field">
              <span className="field-label">Correo de trabajo</span>
              <input name="email" type="email" required autoComplete="email" />
            </label>
            <label className="field">
              <span className="field-label">Teléfono (opcional)</span>
              <input name="phone" type="tel" maxLength={30} autoComplete="tel" />
            </label>
            <label className="field field-wide">
              <span className="field-label">Tipo de entidad (opcional)</span>
              <select name="entity_type" defaultValue="">
                <option value="">Elegir</option>
                {Object.entries(ENTITY_TYPES).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="field field-wide checks">
              <legend className="field-label">Servicios que le interesan (opcional)</legend>
              {SERVICE_KEYS.map((k) => (
                <label key={k} className="check">
                  <input type="checkbox" name="services" value={k} />
                  {MODULES[k]}
                </label>
              ))}
            </fieldset>
            <label className="field field-wide">
              <span className="field-label">Mensaje (opcional)</span>
              <textarea name="message" rows={4} maxLength={2000} placeholder="Por ejemplo: revisamos unas 3,000 boletas médicas al mes." />
            </label>
            <div className="hp" aria-hidden="true">
              <label>
                No llenar este campo
                <input name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>
          </div>
          {error && (
            <p className="note note-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-lg" disabled={state === 'sending'}>
            {state === 'sending' ? 'Enviando…' : 'Solicitar un piloto'}
          </button>
        </form>
      )}
    </section>
  );
}
