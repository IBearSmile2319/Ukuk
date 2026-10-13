# Cómo vender Ukuk

## Recomendación en una línea

**Venta directa y consultiva, hecha por ti, con pilotos pagados.** La página web y la demo dan
credibilidad y captan interesados, pero no van a cerrar ventas solas. A una entidad supervisada se
le vende en reuniones, con un piloto que demuestra resultados medibles.

## Por qué medio se vende y por qué medio se entrega

| | Medio | Para qué |
|---|---|---|
| Captar | Contacto directo (LinkedIn, referidos, gremios), página web con demo | Conseguir la primera reunión |
| Convencer | Demo en vivo de 20 minutos y piloto pagado de 60 a 90 días | Probar con sus propios casos |
| Entregar | Portal web para analistas y oficiales de cumplimiento, API REST para conectar su sistema, WhatsApp con el número de la aseguradora | Uso diario |
| Cobrar | Contrato anual con mínimo mensual y consumo (ver precios en la propuesta) | Ingreso recurrente |

No publiques precios todavía: son hipótesis por validar en las entrevistas. En la web se ofrece el
piloto pagado.

## A quién primero

La propuesta marca como riesgo n.º 1 el conflicto con tu empleo actual en una aseguradora.
**Antes de contactar a cualquier aseguradora, revisa tu contrato con un abogado.** Mientras tanto,
empieza por segmentos que no compiten con tu empleador y que exigen menos certificaciones:

1. **PLAFT para sujetos obligados medianos y pequeños:** cajas, cooperativas, casas de cambio,
   inmobiliarias, notarías. La ley los obliga a revisar listas, no pueden pagar los proveedores
   internacionales y el ciclo de venta es corto.
2. **Verificación documental para créditos:** cajas, cooperativas, financieras y fintech
   (boletas de pago, recibos, DNI en el onboarding).
3. **Corredores de seguros:** documentos y siniestros sin ser una aseguradora.
4. **Aseguradoras medianas, AFOCAT y bancaseguros:** el paquete completo, cuando el tema legal esté
   resuelto y tengas un caso de éxito.

El radar regulatorio se vende como complemento, no como producto de entrada.

## El embudo

1. **Lista de 40 cuentas** de los segmentos 1 y 2, con el nombre del oficial de cumplimiento o del
   jefe de riesgos y créditos.
2. **Diez entrevistas** (las de la propuesta) antes de vender: cuánto pierden al año por fraude
   documental, cuánto tarda un analista por caso y cómo revisan hoy las listas. Las respuestas
   ajustan precios y mensajes.
3. **Demo de 20 minutos** a quienes muestren el dolor (guion abajo).
4. **Piloto pagado** con meta de éxito por escrito.
5. **Contrato anual** al cumplir la meta.

Canales para conseguir reuniones: tu red de LinkedIn y referidos del sector, y los gremios de cada
segmento (por ejemplo APESEG para aseguradoras, ASBANC para bancos, FEPCMAC para cajas municipales,
FENACREP para cooperativas). Un taller gratuito sobre la nueva debida diligencia de proveedores
(Res. SBS 01015-2026) es buen gancho para oficiales de cumplimiento.

## Guion de la demo (20 minutos)

Usa siempre los datos de demostración (`node demo/seed.mjs`); nunca documentos reales del
prospecto antes de firmar un acuerdo de confidencialidad y de tratamiento de datos.

1. **El problema (2 min):** el DNIe 3.0 convive con dos versiones anteriores, falsificar una boleta
   con IA es barato, y la SBS amplió la debida diligencia en abril de 2026.
2. **Documentos (6 min):** sube la boleta adulterada y deja que el inspector la recorra. Muestra el
   total que no cuadra, la zona pegada y el informe auditable. Luego el DNI con el número cambiado
   frente al MRZ. Cierra con la boleta legítima aprobada: así se ve que no rechaza todo.
3. **PLAFT (5 min):** da de alta un proveedor que coincide con una lista PEP, abre el caso, toma la
   decisión con su sustento y verifica la cadena de auditoría.
4. **Siniestros (5 min):** el simulador de WhatsApp en tu celular o en pantalla, de "Hola" al caso
   registrado con fotos en vivo y el reloj SBS corriendo.
5. **Cierre (2 min):** la propuesta de piloto con su meta de éxito.

## El piloto pagado

- **Duración:** 60 a 90 días, a precio reducido.
- **Meta de éxito por escrito:** por ejemplo, documentos alterados detectados, horas de analista
  ahorradas o tiempo de respuesta en siniestros. Si se cumple, pasa a contrato anual.
- **Documentos que necesitas tener listos:**
  - acuerdo de confidencialidad;
  - contrato de piloto con su anexo de encargo de tratamiento de datos (Ley 29733);
  - anexo de seguridad: cifrado por cliente, aislamiento, auditoría, notificación de incidentes,
    estrategia de salida y región de procesamiento (Res. SBS 504-2021 y 272-2017);
  - descripción del modelo para riesgo de modelo (Res. SBS 053-2023): qué mide cada capa y que el
    modelo de lenguaje no decide.
- **Medir desde el día 1:** detección, falsos positivos, tiempo por caso. Son tu caso de éxito.

## Lo que falta para el primer piloto

- Revisión legal del contrato laboral.
- Despliegue en AWS en la región acordada, con dominio propio y correo de contacto (la web tiene
  marcadores `[CORREO DE CONTACTO]`).
- Probar los conectores de SUNAT y RENIEC con las credenciales del cliente.
- Para siniestros: número de WhatsApp Business de la aseguradora y plantillas aprobadas por Meta.
- Iniciar el camino a ISO 27001 o SOC 2 antes del primer contrato grande.
