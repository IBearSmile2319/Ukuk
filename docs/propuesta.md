<!-- Copia de trabajo de la propuesta original (documento en Claude Docs). -->
# Suite antifraude y cumplimiento para seguros y banca

## Resumen ejecutivo
La propuesta son cuatro servicios independientes que comparten una misma plataforma. Cada uno se vende por separado, con su propio precio, y también existe un paquete con descuento para quien compre varios. El servicio ancla es la verificación documental: no encontré un competidor que combine el análisis forense de documentos peruanos con la validación contra RENIEC, SUNAT y SUSALUD.

| Servicio | Qué resuelve | Comprador principal | Cómo se cobra |
|---|---|---|---|
| 1. Verificación documental | Detecta alteraciones, ilegibilidad y DNI falsos; extrae los datos y entrega un informe con los hallazgos marcados | Siniestros y reembolsos (seguros), créditos y onboarding (banca, cajas, fintech) | Por documento analizado + mínimo mensual |
| 2. Radar regulatorio | Vigila las normas nuevas y dice qué proceso interno impactan | Cumplimiento normativo y legal de entidades SBS | Suscripción mensual |
| 3. PLAFT | Revisa clientes, proveedores y trabajadores contra listas, PEP y noticias negativas | Oficiales de cumplimiento de los sujetos obligados ante la UIF | Por consulta + registros monitoreados al mes |
| 4. Siniestros por WhatsApp | El asegurado reporta su siniestro por chat; el caso llega completo y verificado al ajustador | Aseguradoras medianas, corredores, AFOCAT, bancaseguros | Implementación + por siniestro gestionado |

El momento es bueno por cuatro cambios recientes:
Desde agosto de 2025 RENIEC solo emite el DNIe 3.0, y conviven tres versiones de DNI válidas.
En abril de 2026 la SBS amplió la debida diligencia PLAFT, incluida la de proveedores.
Con IA generativa es barato producir un documento falso convincente.
Las aseguradoras grandes ya atienden siniestros con IA, y las medianas necesitan alcanzarlas sin construirlo ellas mismas.

## Servicio 1 — Verificación documental antifraude
El cliente sube una imagen o un PDF y en segundos recibe tres cosas: un puntaje de riesgo, los datos extraídos y un informe que señala dónde está cada problema. Sirve para DNI, boletas de pago, recibos de servicios, facturas y boletas electrónicas, informes médicos, recetas, actas y certificados.

### Formatos aceptados
Aceptamos casi cualquier formato, pero cuanto más cerca esté el archivo del original digital, más se puede probar. Una foto pierde información que un PDF nativo o un XML conservan.

| Formato | Valor forense | Qué permite revisar |
|---|---|---|
| XML de comprobante electrónico SUNAT | Muy alto | Firma digital del emisor y comparación con el PDF que se presentó |
| PDF nativo (generado por un sistema) | Alto | Metadatos, fuentes incrustadas, objetos agregados y ediciones posteriores al original |
| Imagen: JPG, PNG, HEIC, WEBP, TIFF | Medio | Tipografía, alineación, compresión, zonas copiadas, plantilla |
| PDF escaneado | Medio | Lo mismo que una imagen |
| Video corto: MP4, MOV (solo siniestros) | Medio | Cuadros del daño desde varios ángulos |
| Nota de voz (solo siniestros) | Bajo | Se transcribe como relato del asegurado |
| Word y Excel (segunda fase) | Bajo | Son editables por naturaleza; solo sirven para extraer datos |

El ZIP se acepta solo para enviar lotes. Dos señales se marcan siempre:
Una foto tomada a una pantalla en vez del papel.
Un PDF protegido con contraseña que no se puede abrir.

### Qué revisa, capa por capa

| Capa | Qué detecta | Cómo |
|---|---|---|
| Calidad y legibilidad | Foto borrosa, reflejos, esquinas cortadas, baja resolución, partes tapadas | Métricas de imagen antes de analizar; si falla, se le pide al usuario otra foto |
| Clasificación | Tipo de documento, emisor y versión | Modelo de visión + reglas por emisor |
| Extracción | Nombres, DNI, RUC, montos, fechas, diagnósticos, número de comprobante | OCR con posición de cada palabra + esquema de campos por tipo |
| Consistencia interna | Sumas que no cuadran, IGV mal calculado, fechas imposibles, dígitos de control del MRZ que no coinciden con lo impreso | Reglas deterministas |
| Forense de imagen | Tipografía mezclada, letras desalineadas o con otro espaciado, zonas copiadas y pegadas, compresión distinta en una zona, metadatos de edición | Medición de glifos dentro del mismo documento + análisis de compresión y bordes |
| Plantilla de referencia | Logo, posiciones o fuentes que no corresponden al emisor y al año del documento | Comparación contra el perfil del emisor y la versión (ver la sección siguiente) |
| Validación externa | Comprobante inexistente o anulado, RUC dado de baja, clínica no registrada, médico inexistente | SUNAT, RENIEC, RENIPRESS y Colegio Médico |
| Reuso | La misma boleta o foto presentada en otro reclamo | Huella perceptual de cada imagen contra el historial del cliente |

El modelo de lenguaje no decide solo. Las capas deterministas miden, y el modelo interpreta esas mediciones y los recortes ampliados para redactar la explicación. Así cada hallazgo se puede auditar.

### DNI fraudulentos
Versiones vigentes: desde el 29 de agosto de 2025 RENIEC solo emite el DNIe 3.0, pero el DNI azul (adultos) y el amarillo (menores) siguen válidos hasta su vencimiento. El sistema tiene que reconocer las tres.
Qué se puede comprobar con una foto: que el MRZ (las 3 líneas que empiezan con I<PER) cuadre con sus dígitos de control y con los datos impresos; la disposición de los elementos según la versión; la tipografía; y si la foto del rostro fue pegada o editada.
Qué no se puede comprobar con una foto: hologramas, tintas UV y la foto fantasma. Para una verificación fuerte hay dos caminos:
Comparar el rostro con la foto de RENIEC (servicio biométrico facial, S/ 0.70 por consulta).
Leer el chip del DNIe por NFC desde el celular.

### El informe
Puntaje de 0 a 100 con semáforo: aprobar, revisar o rechazar.
Cada hallazgo marcado con una caja sobre la imagen, un recorte ampliado, la explicación y su nivel de confianza.
Los datos extraídos en JSON, para que el sistema del cliente los use sin volver a tipearlos.
Las respuestas de las fuentes oficiales consultadas, con fecha y hora.

### La experiencia de análisis
Mientras se analiza el documento, un inspector con forma de araña recorre la imagen. Cada pata se apoya en una caja de texto que el OCR encontró. A su paso dibuja cajas azules sobre los datos extraídos y rojas sobre las anomalías, y al terminar los hallazgos quedan marcados sobre el documento.
La animación refleja el avance real del análisis, así que funciona como barra de progreso.
Dura entre 3 y 6 segundos y luce mucho en una demo.
Para analistas que procesan cientos de documentos al día hay un modo compacto o para saltarla, y se respeta la preferencia de movimiento reducido del sistema.

## ¿Depende de los documentos legítimos que entregue el cliente?
Solo en parte. Unas capas funcionan desde el primer día sin ningún ejemplo, y otras mejoran con muestras legítimas de cada emisor. Tienes razón en que importan el año y la versión: una boleta de 2021 de una clínica no tiene por qué verse igual que una de 2026.

| Tipo de revisión | ¿Necesita muestras legítimas? | Ejemplos |
|---|---|---|
| Independiente de la plantilla | No, funciona desde el día 1 | Legibilidad, sumas e IGV, MRZ, comparación de letras dentro del mismo documento, compresión, metadatos, validación en SUNAT y RENIEC, reuso |
| Por emisor y versión | Sí, unas pocas muestras por versión | Posición del logo y los campos, fuentes del emisor, formato del número de serie, sellos y firmas |
| Aprendida del historial | Se construye sola con el uso | Patrones de un mismo médico, clínica o taller que se repiten en reclamos sospechosos |

Cómo se organiza la biblioteca de plantillas:
Cada perfil se guarda por tipo de documento, emisor, versión y rango de fechas. Por ejemplo: "boleta electrónica, Clínica X, formato 2, de marzo de 2023 a hoy".
La fecha que figura en el propio documento elige qué versión esperar. Si una boleta dice 2022 pero usa el formato que la clínica estrenó en 2024, eso es una anomalía.
Agregar un tipo de documento nuevo no exige reentrenar nada: se registra un perfil a partir de las muestras.
De dónde salen las muestras:
El cliente entrega documentos que ya aprobó. Como punto de partida, entre 10 y 30 por emisor y versión; es una estimación que hay que ajustar en el piloto.
Especímenes públicos, como las imágenes de muestra del DNI que publica RENIEC.
Los documentos que un analista marca como legítimos durante la operación, que van ampliando la biblioteca.
Cuando no hay plantilla, el puntaje se arma solo con las capas independientes y el informe lo dice claramente: "sin plantilla de referencia, confianza limitada". Es mejor que fingir certeza.

## Servicio 2 — Radar regulatorio
Es el servicio más fácil de construir y también el más disputado. Para competir no basta avisar que salió una norma: hay que conectar cada norma con los procesos internos del cliente.
Fuentes:
El Peruano, Normas Legales: cada norma sale en HTML con su PDF. No encontré una API ni un RSS oficial, y sus términos no dicen nada sobre reutilización comercial. Conviene pedir autorización a Editora Perú antes de automatizar.
SBS: resoluciones y proyectos de norma prepublicados para comentarios, en una aplicación web con documentos PDF.
Otros reguladores: SMV, BCRP, UIF, SUSALUD e INDECOPI se suman por etapas.
Volumen: la SBS emitió unas 4,500 resoluciones en 2025, aunque la mayoría son particulares (autorizaciones, registros). Las normas de carácter general serían unas decenas al año. El valor está en filtrar ese ruido.
Qué entrega el servicio:
Un resumen diario solo con lo relevante para ese cliente, según su tipo de entidad y sus líneas de negocio.
Una matriz de impacto: qué artículo afecta qué política, proceso o manual interno, con la fecha de entrada en vigor. Para eso el cliente carga una vez su inventario de políticas y procesos.
Tareas con responsable y plazo para adecuarse, y el seguimiento hasta cerrarlas.
Un borrador de comentarios para los proyectos de norma que la SBS somete a consulta.
Competencia directa: RegAlert ya monitorea la SBS con alertas el mismo día, resúmenes con IA y un conector MCP gratuito. vLex ofrece alertas de búsqueda, y los estudios de abogados reparten boletines gratis. La diferencia defendible es la matriz de impacto conectada a los procesos de cada cliente.
Recomendación: venderlo como complemento de los otros servicios, no como producto de entrada.

## Servicio 3 — PLAFT (prevención de lavado de activos)
El mercado está en los sujetos obligados medianos y pequeños. La ley los obliga a revisar listas, y no pueden pagar World-Check ni Dow Jones. Los bancos grandes ya tienen proveedor.
Quiénes están obligados (selección): cooperativas, casas de cambio, empresas de préstamo y empeño, remesadoras y empresas de transferencia de fondos. También inmobiliarias, constructoras y agentes inmobiliarios; notarios; casinos y apuestas en línea; comercio de vehículos, joyas y metales preciosos; agentes de aduana; mineras; plataformas de crowdfunding; abogados y contadores; y, desde 2023, los proveedores de activos virtuales.
Qué exige la norma:
Res. SBS 789-2018 (sujetos supervisados por la UIF): debida diligencia en tres regímenes (general, reforzado y simplificado). Exige revisar las listas OFAC, ONU, UE y países no cooperantes para clientes, trabajadores, directores y proveedores.
Res. SBS 01015-2026 (abril de 2026): suma el financiamiento de la proliferación, amplía los datos mínimos del cliente y exige debida diligencia de proveedores actualizada al menos cada 2 años.
Res. SBS 2660-2015: la norma equivalente para las empresas que supervisa directamente la SBS.
Régimen PEP (Res. SBS 4349-2016, modificada en enero de 2025): fija una lista cerrada de cargos, y además cada entidad debe detectar por riesgo a otros PEP.
Fuentes de listas:
Lista consolidada del Consejo de Seguridad de la ONU, en XML.
OFAC SDN de EE. UU., en XML y CSV.
Lista consolidada de sanciones de la UE.
Las páginas de listas de interés y de congelamiento de la SBS.
El hueco: en Perú no hay una lista oficial de nombres de PEP; la norma solo define cargos. Se puede construir una base propia con fuentes públicas: designaciones en El Peruano, Infogob del JNE y las declaraciones juradas ante la Contraloría. Esa base es un activo difícil de copiar.
Qué entrega el servicio:
Consulta al momento de vincular a un cliente, proveedor o trabajador, por API o en un portal.
Revisión nocturna de toda la cartera cada vez que cambia una lista.
Coincidencia de nombres pensada para nombres peruanos: dos apellidos, tildes, partículas como "de la" y errores de tipeo.
Noticias negativas: el modelo lee medios peruanos y resume si la noticia es sobre la misma persona.
Gestión de casos para el oficial de cumplimiento, con decisión, sustento y registro de auditoría listo para la supervisión.
Referencia de precio: Sumsub publica US$ 1.85 por verificación con screening AML y monitoreo continuo, con un mínimo de US$ 299 al mes.

## Servicio 4 — Siniestros por WhatsApp
Sí es viable. Meta permite los bots de atención propios de un negocio; desde el 15 de enero de 2026 solo prohíbe que el servicio principal sea un asistente de IA de propósito general. El reto es comercial: Pacífico ya atiende siniestros vehiculares por WhatsApp con su asistente "Vera" y Rimac tiene su propio bot con IA. Los clientes de este servicio son las aseguradoras medianas, los corredores, las AFOCAT y la bancaseguros.
Los casos de riesgo alto pasan por un analista antes de llegar al ajustador. El plazo legal corre desde el primer mensaje.
Lo que impone WhatsApp:
Costo por mensaje: Meta cobra por mensaje desde julio de 2025. Según varios proveedores, desde el 1 de octubre de 2026 también se cobran los mensajes de atención, a unos US$ 0.03 cada uno en Perú. La página oficial de Meta todavía no lo refleja, así que hay que confirmarlo. Un siniestro de unos 20 mensajes costaría alrededor de US$ 0.60, por eso conviene diseñar conversaciones cortas.
Límites de archivos: imagen 5 MB; video 16 MB; audio y notas de voz 16 MB; documentos 100 MB. El enlace de cada archivo vence a los 5 minutos y su identificador a los 7 días, así que hay que descargarlo y guardarlo de inmediato.
Ubicación: se recibe la ubicación del momento, no la ubicación en tiempo real.
Metadatos: una foto enviada de la forma normal pierde el GPS y la fecha. La solución es mandar un enlace a una página de captura que toma la foto en vivo con la cámara (sin acceso a la galería), con hora y GPS. Cada foto pasa por el Servicio 1 para detectar reuso o imágenes generadas con IA.
El número es de la aseguradora: la cuenta de WhatsApp Business se verifica a su nombre, y nosotros operamos como proveedor tecnológico.
Lo que impone la SBS (Res. SBS 3202-2013 y Ley 29946):
Plazo de aviso: 3 días en seguros de daños y 7 en seguros de personas, salvo que la póliza dé más plazo.
WhatsApp tiene que estar pactado en la póliza como medio de comunicación. No encontré una norma que obligue a aceptarlo.
Plazo de respuesta: sin ajustador, la aseguradora tiene 30 días para aprobar o rechazar, y solo puede pedir aclaraciones en los primeros 20. Si no responde, el siniestro queda consentido (aprobado) y debe pagarse en 30 días.
Argumento de venta: el sistema lleva el reloj de cada caso y avisa antes de que un siniestro quede consentido por falta de respuesta.
Qué necesita el cliente para empezar:
Una API para consultar pólizas, o al menos un archivo diario.
Su número de WhatsApp Business.
Las reglas de qué siniestros atiende el bot; por ejemplo, choque leve, robo de celular o reembolso de salud.
El destino de cada caso: el sistema de siniestros o el correo del ajustador.

## Requisitos para venderle a entidades supervisadas
Para una entidad supervisada por la SBS somos un proveedor tecnológico y, en varios casos, una "subcontratación significativa". Eso pide certificaciones y cláusulas desde el primer contrato. Es lo que más alarga una venta, así que conviene prepararlo antes de salir a vender.

| Requisito | Norma | Qué implica para nosotros |
|---|---|---|
| Seguridad de la información del proveedor | Res. SBS 504-2021 | En servicios significativos en la nube, la entidad verifica cada año que tengamos ISO 27001, 27017 y 27018, o informes independientes de controles. También exige una estrategia de salida para migrar los datos, y la entidad informa a la SBS hasta 30 días después de empezar a usar el servicio |
| Subcontratación significativa | Res. SBS 272-2017, arts. 35 a 37 | Cláusulas que permitan auditorías de la entidad, de sus auditores y de la SBS. Procesar datos fuera del Perú requiere autorización previa de la SBS, que pide la entidad. La región de AWS es una decisión de contrato |
| Riesgo de modelo | Res. SBS 053-2023 | Si nuestro modelo influye en decisiones, la entidad tiene que poder explicarlo y replicarlo. Un informe con mediciones auditables ayuda; una caja negra no pasa. No confirmé su alcance exacto para aseguradoras |
| Datos personales | Ley 29733 y DS 016-2024-JUS (vigente desde marzo de 2025) | Somos encargados del tratamiento. Notificar incidentes a la autoridad en 48 horas, usar cláusulas modelo si los datos salen del país y tratar la biometría (rostro) como dato sensible |
| Acceso a RENIEC | Convenio con RENIEC | Exige convenio y prohíbe revender los datos. Lo más probable es operar con el convenio de cada cliente, usando sus credenciales, y no revender un acceso propio |
| Exigencias de cada cliente | Términos de seguridad para proveedores (Rimac como ejemplo) | ISO 27001 o SOC 2; hasta 2 pruebas de penetración al año; aviso de incidentes en 24 horas o menos; aprobación previa de subcontratistas; devolver o destruir los datos en 15 días al terminar |

En la práctica:
Construir desde el día 1 con cifrado por cliente, registro de auditoría y aislamiento entre clientes.
Iniciar el camino hacia ISO 27001 o SOC 2 antes del primer contrato grande.
Empezar con clientes que piden menos, como corredores, inmobiliarias y casas de cambio, mientras llega la certificación.

## Arquitectura técnica propuesta
Una sola plataforma multicliente sirve a los cuatro servicios, y cada servicio es un módulo que se activa por contrato. Encaja con tu stack: NestJS, PostgreSQL y AWS serverless.
El servicio de siniestros reutiliza el documental para verificar cada foto y documento que llega por WhatsApp.
Procesamiento: colas y funciones serverless (SQS, Lambda, Step Functions). Así, un análisis que tarda segundos no necesita servidores encendidos todo el día.
Lectura y análisis: OCR con la posición de cada palabra (Amazon Textract u otro motor) y un modelo de visión que solo interpreta mediciones y recortes.
Aislamiento: datos separados por cliente, llaves de cifrado propias en KMS y un registro de auditoría que no se puede alterar.
Región de procesamiento: se define con cada cliente, porque procesar fuera del Perú requiere autorización de la SBS.

## Modelo de negocio, precios y rentabilidad
Cada servicio tiene su precio, y quien compra varios obtiene un paquete con descuento. Con los supuestos de abajo, el negocio cubre sus costos fijos con unos 12 clientes de ticket medio. Todos los precios son hipótesis para validar en las entrevistas y no incluyen IGV.

### Precio por servicio

| Servicio | Unidad de cobro | Precio de lista propuesto | Costo variable estimado | Margen bruto |
|---|---|---|---|---|
| 1. Verificación documental | Por documento | Extracción S/ 0.50 · Verificación S/ 2.50 · Forense con informe S/ 5.00; mínimo S/ 1,500 al mes | S/ 0.10 a 0.40 (OCR + modelo); RENIEC lo paga el cliente con su convenio | 85% a 95% |
| 2. Radar regulatorio | Suscripción mensual | S/ 1,200 (alertas y resúmenes) a S/ 4,500 (matriz de impacto, varios reguladores) | Casi fijo: cada norma se procesa una vez para todos los clientes | Más de 90% desde ~5 clientes |
| 3. PLAFT | Por consulta + por registro monitoreado | S/ 1.50 por alta · S/ 0.15 por registro al mes; mínimo S/ 600 al mes | Listas gratuitas; noticias negativas S/ 0.05 a 0.20 por consulta | 85% a 90% |
| 4. Siniestros por WhatsApp | Implementación + por siniestro | S/ 20,000 a 40,000 de implementación · S/ 15 a 25 por siniestro; mensajes de WhatsApp al costo | S/ 3 a 5 por siniestro (mensajes, modelo, verificación) | 70% a 80% |

Como referencia, Sumsub cobra US$ 1.35 a 1.85 por verificación con mínimos de US$ 149 a 299 al mes. Truora y Jumio cobran entre US$ 0.50 y 5 según estimaciones de terceros.

### Paquete
Dos servicios: 10% de descuento sobre la suma.
Tres o más: 20% de descuento, con un solo mínimo mensual y contrato anual.
Piloto pagado: 60 a 90 días a precio reducido, con una meta de éxito acordada por escrito (por ejemplo, fraudes detectados o horas de analista ahorradas). Si se cumple, pasa a contrato anual.
El paquete se vende mejor a una entidad con varios dolores a la vez. Una aseguradora mediana, por ejemplo, necesita siniestros, verificación documental y PLAFT.

### Rentabilidad
Supuestos de costos fijos: S/ 50,000 al mes en total.
Equipo de 4 personas: S/ 40,000.
Infraestructura base, herramientas, legal y contabilidad: S/ 6,000.
Certificación ISO 27001 o SOC 2, prorrateada: S/ 4,000.
Supuestos por cliente: ticket medio de S/ 5,000 al mes y margen de contribución de 85%. Cada cliente aporta S/ 4,250, así que el punto de equilibrio son unos 12 clientes.

| Escenario | Clientes | Ticket mensual | Ingreso mensual | Resultado mensual |
|---|---|---|---|---|
| Conservador | 6 | S/ 4,000 | S/ 24,000 | −S/ 29,600 |
| Base | 12 | S/ 5,000 | S/ 60,000 | +S/ 1,000 |
| Optimista | 20 | S/ 7,000 | S/ 140,000 | +S/ 69,000 |

Un solo cliente grande de siniestros cambia la cuenta: 2,000 casos al mes a S/ 20 son S/ 40,000 mensuales. Por eso conviene ir por pocos clientes con volumen y no por muchos clientes pequeños.

## Competencia y posicionamiento
Los líderes en forense documental son europeos y estadounidenses y no conocen los documentos peruanos. Los líderes en LatAm verifican identidad, pero no analizan boletas, recetas ni comprobantes. El posicionamiento propuesto es el antifraude documental peruano, conectado a las fuentes oficiales del país.

| Competidor | Qué hace | ¿Forense de documentos? | Presencia y precio |
|---|---|---|---|
| Resistant AI | Forense documental con más de 500 indicadores, incluidos falsos hechos con IA; caso de uso de siniestros | Sí | Foco en Europa; precio no público |
| Inscribe | Fraude en estados de cuenta, boletas de pago y facturas | Sí | EE. UU.; cobra por documento, monto no público |
| Incode / MetaMap | Onboarding KYC con registros públicos de LatAm | Solo documentos de identidad | LatAm; precio a medida |
| Truora, Jumio | Verificación de documento de identidad + biometría | No | LatAm; US$ 0.50 a 5 según terceros |
| Facephi | Biometría facial | No | Unos 30 clientes en Perú |
| Sumsub | KYC + screening AML | No | Global; US$ 1.35 a 1.85 por verificación |
| RegAlert | Alertas de normas SBS con resúmenes de IA | No aplica | Competidor directo del radar |
| Bots propios de Pacífico y Rimac | Siniestros vehiculares con IA | Parcial | No venden a terceros, pero fijan la expectativa del mercado |
| Tractable, Solera Qapter | Estimación de daños vehiculares por foto | No | Brasil y global; pueden ser socios del servicio de siniestros, no rivales |

Ventajas defendibles:
Biblioteca de plantillas de emisores peruanos por versión y año.
Conectores a SUNAT, RENIEC, RENIPRESS y Colegio Médico.
Base propia de PEP peruanos.
Conocimiento de la norma SBS desde adentro.
Ninguna de estas ventajas es tecnología imposible de copiar: son datos y relaciones que toman tiempo. Por eso importa llegar primero.

## Hoja de ruta
Son cuatro fases en unos 12 meses, y cada fase empieza solo si se cumplió la condición anterior. El servicio documental va primero porque es el de mayor valor y porque el de siniestros lo reutiliza.
Los plazos suponen un equipo de 3 o 4 personas a tiempo completo; con dedicación parcial se alargan.

## Riesgos y próximos pasos
El riesgo más grande no es técnico: es el conflicto con el empleo actual en una aseguradora. Hay que resolverlo antes de escribir la primera línea de código.

| Riesgo | Por qué importa | Cómo mitigarlo |
|---|---|---|
| Conflicto con el empleador | Vender antifraude y siniestros a otras aseguradoras es venderle a la competencia; los contratos suelen incluir exclusividad, propiedad intelectual y no competencia | Revisar el contrato con un abogado. Empezar por segmentos que no compiten, como PLAFT para inmobiliarias o documentos para cajas, y no usar nada aprendido adentro |
| Acceso a fuentes | RENIEC prohíbe revender datos; varios portales (SUNARP, Colegio Médico, El Peruano) no tienen API y sus términos no son claros | Operar con el convenio de cada cliente; pedir autorizaciones; usar las APIs oficiales donde existan, como SUNAT |
| Falsos positivos | Rechazar a un cliente legítimo cuesta caro y genera reclamos | El sistema recomienda y la entidad decide; todo hallazgo queda explicado y revisable por un analista |
| Ciclo de venta largo | Las entidades grandes tardan meses en evaluar a un proveedor | Empezar con corredores, cajas e inmobiliarias; pilotos pagados con meta de éxito |
| Certificaciones | ISO 27001 o SOC 2 cuestan y toman tiempo | Diseñar los controles desde el día 1 y certificar cuando llegue el primer contrato grande |
| Costos de WhatsApp | Meta cambia sus tarifas con frecuencia | Trasladar el costo de mensajes al cliente, al costo |

Próximos pasos:
Revisar el contrato laboral (exclusividad, propiedad intelectual, no competencia) antes de construir.
Hacer 10 entrevistas: 3 aseguradoras medianas o corredores, 3 cajas o cooperativas, 2 inmobiliarias o casas de cambio y 2 oficiales de cumplimiento. Preguntar cuánto pierden al año por fraude documental y cuánto tarda un analista por caso.
Conseguir unos 200 documentos reales anonimizados de un posible piloto, con acuerdo de confidencialidad, para medir la detección.
Prototipar el Servicio 1 con DNI, comprobantes SUNAT y boletas médicas.
Confirmar en la página oficial de Meta las tarifas de WhatsApp para Perú desde octubre de 2026.
Consultar a un abogado sobre el convenio RENIEC, los términos de uso de los portales y el rol de encargado de datos.
Cerrar una carta de intención para un piloto pagado.

## Fuentes
Identidad y documentos
RENIEC: tarifas de servicios de verificación, presentación al Congreso (mayo de 2025)
RENIEC reduce campos de la Consulta en Línea (Canal N)
Desde hoy solo se emitirá el DNIe 3.0 (Canal N)
DNIe 3.0: elementos de seguridad (Gestión)
Significado del MRZ del DNI (Gestión)
Análisis del DNIe peruano (Privacy International)
SUNAT: manual de Consulta Integrada de Comprobantes por servicio web
Regulación y PLAFT
Proyectos de normas de la SBS
Res. SBS 789-2018 (CMS Grau)
Res. SBS 01015-2026: FT y FP (PRC)
Cambios en la identificación de PEP (El Peruano)
Listas de interés de la SBS
DS 006-2023-JUS (El Peruano)
Res. SBS 504-2021: seguridad de la información (CMS)
Mejoran reglas de seguridad de la información (El Peruano)
Res. SBS 272-2017: gobierno corporativo y gestión de riesgos
Res. SBS 053-2023: riesgo de modelo (El Peruano)
Nuevo reglamento de datos personales (IAPP)
Nuevo reglamento de datos personales (Pérez-Llorca)
Términos de seguridad de la información para proveedores de Rimac
Siniestros y WhatsApp
Precios de WhatsApp Business Platform (Meta)
Cambio de precios desde el 1 de octubre de 2026 (YCloud)
Tarifas de WhatsApp para Perú (Mercately)
Prohibición de chatbots de propósito general (respond.io)
Archivos multimedia en WhatsApp Cloud API (Meta)
Metadatos de fotos en WhatsApp (fast.io)
Res. SBS 3202-2013: gestión y pago de siniestros
La IA acelera la atención de seguros vehiculares (El Peruano)
Rimac: IA reduce a un minuto el análisis de siniestros (Infomercado)
Mercado y fraude
Médico que "resucitaba muertos" para estafar aseguradoras (El Imparcial)
Cómo operan los defraudadores de seguros (El Tiempo)
Proveedores de verificación de identidad en LatAm (Didit)
