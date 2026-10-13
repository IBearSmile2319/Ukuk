# Motor Ukuk (`ukuk-engine`)

Servicio Rust **sin estado de cliente** que mide documentos (imágenes, PDF, XML
SUNAT), aplica reglas peruanas (RUC, DNI, MRZ, comprobantes, fechas) y busca
nombres en listas de vigilancia. El contrato HTTP está en
[`../docs/contrato-motor.md`](../docs/contrato-motor.md).

## Desviaciones del contrato

Todas son **aditivas o precisan casos que el contrato no define**: ningún campo
del contrato cambia de nombre, tipo ni significado.

1. **Campo extra `mrz.dni`** (`string | null`) en `/v1/analyze` y `/v1/rules/mrz`:
   el DNI de 8 dígitos, tomado del número de documento o, si este no es un DNI,
   de los datos opcionales de la MRZ. Los cruces `mrz.dni_mismatch` lo usan.
2. **Espacios de nombres extra en `Finding.code`**: `dni.*` (formato del DNI impreso)
   y `xml.*` (`xml.mismatch_with_pdf`, `xml.unsigned`, `xml.not_sunat_ubl`).
3. **`mime_type` de la respuesta = tipo detectado.** Si los bytes no coinciden con el
   MIME declarado, se analiza según el contenido real, se devuelve ese tipo y se emite
   `file.mime_mismatch`.
4. **`image.ela` puede ser `null`** en imágenes de más de 40 MP (se emite `ela.skipped`).
5. **Errores adicionales**: `405 method_not_allowed` para un método no soportado. Los
   códigos de error se listan [más abajo](#errores).
6. **`PUT /v1/watchlists/{source}` acepta hasta 200 MB** (los 25 MB del contrato
   aplican a `/v1/analyze` y demás rutas JSON).
7. **`/v1/screen` y `/v1/screen/batch` devuelven `404 unknown_source`** si `sources`
   pide una lista que no está cargada. Así no se oculta un falso negativo. Sin
   `sources` se consultan todas las listas cargadas, y si no hay ninguna la
   respuesta es `matches: []`.
8. **Validaciones de screening**: `threshold` ∈ [0, 1] y `limit` ≤ 1000 (si no, `422`).
   El lote acepta además `sources`, `limit` y `nationality` por sujeto.
9. **Entradas permisivas**: los montos de `fields` aceptan texto o número JSON. En
   `OcrWord`, `confidence` (por defecto 1) y `page` (por defecto 1) son opcionales. Las
   anclas de plantilla aceptan un `page` opcional. Un `document_type` desconocido se
   trata como `other`.
10. **Listas OFAC**: los registros `vessel` y `aircraft` se exponen con
    `kind: "entity"`, y `remarks` lleva el prefijo `[vessel]` / `[aircraft]`.
    `birth_dates` puede contener fechas parciales (`"1960"`, `"1960-03"`).
11. **`ukuk_jsonl`**: `kind` y las listas (`aliases`, `birth_dates`…) son opcionales en cada línea; `id` y `name` son obligatorios.

## Ejecutar

```bash
cargo run --release -p ukuk-engine            # escucha en 0.0.0.0:8090
UKUK_DATA_DIR=./data cargo run --release -p ukuk-engine

docker build -t ukuk-engine .
docker run -p 8090:8090 -v ukuk-data:/data ukuk-engine
```

| Variable            | Por defecto    | Uso                                                                         |
|---------------------|----------------|-----------------------------------------------------------------------------|
| `UKUK_ENGINE_ADDR`  | `0.0.0.0:8090` | Dirección de escucha.                                                       |
| `UKUK_DATA_DIR`     | (vacío)        | Directorio donde se guardan las listas (`watchlists/<source>.raw` + `.json`), que se recargan al iniciar. Sin él, las listas solo viven en memoria. |
| `RUST_LOG`          | `info`         | Filtro de logs (`tracing`).                                                 |
| `UKUK_LOG_FORMAT`   | texto          | `json` para logs JSON.                                                      |

El trabajo pesado (análisis, parseo de listas, búsquedas por lote) corre en
`spawn_blocking`. Las búsquedas por lote se paralelizan con rayon.

## Endpoints

| Método y ruta                       | Descripción                                                              |
|-------------------------------------|--------------------------------------------------------------------------|
| `GET /health`                       | `{"status":"ok","version":"0.1.0"}`                                      |
| `POST /v1/analyze`                  | Analiza un archivo (base64) y devuelve mediciones + `findings`, `sha256`, `duration_ms`. |
| `POST /v1/rules/ruc`                | `{"ruc"}` → `{"valid","kind"}`                                           |
| `POST /v1/rules/mrz`                | `{"mrz"}` → objeto `mrz` + `findings`                                    |
| `PUT /v1/watchlists/{source}?format=&category=` | Carga/reemplaza una lista (cuerpo crudo). Formatos: `ofac_sdn_csv`, `un_xml`, `ukuk_jsonl`. |
| `GET /v1/watchlists`                | Metadatos de las listas cargadas.                                        |
| `DELETE /v1/watchlists/{source}`    | `204`, o `404` si no existe.                                             |
| `POST /v1/screen`                   | Búsqueda de un nombre.                                                   |
| `POST /v1/screen/batch`             | Búsqueda por lotes (`results` en el mismo orden que `subjects`).         |

Con un `document_type` dado, `/v1/analyze` hace lo siguiente:

1. Decodifica el base64 (estándar o URL-safe, acepta prefijo `data:`) y calcula SHA-256.
2. Detecta el tipo real por bytes mágicos y despacha a imagen, PDF o XML.
3. Si hay `fields`, aplica las reglas peruanas y, si viene `fields.mrz`, analiza la
   MRZ y la cruza con los campos impresos.
4. Si hay `ocr_words`, revisa la disposición del texto.
5. Compara con `template`, o emite `template.none` si no se envía plantilla.
6. Ordena los hallazgos por severidad, de mayor a menor.

Un archivo dañado no es un error HTTP: devuelve `200` con `file.unreadable` y el
bloque correspondiente en `null`.

### Errores

`{"error": "<codigo>", "message": "<texto>"}`

| HTTP | `error`                                                                 |
|------|-------------------------------------------------------------------------|
| 400  | `invalid_json`, `invalid_content_type`, `invalid_base64`, `empty_file`, `unsupported_mime_type`, `invalid_source`, `invalid_format`, `invalid_category`, `empty_body`, `invalid_body` |
| 404  | `not_found`, `unknown_source`                                           |
| 405  | `method_not_allowed`                                                    |
| 413  | `payload_too_large`                                                     |
| 422  | `invalid_request` (falta un campo o hay un tipo o valor inválido), `invalid_watchlist` (archivo de lista mal formado) |
| 500  | `internal_error`                                                        |

## Qué mide cada verificación (y qué no puede medir)

El motor **mide señales**. No decide si un documento es fraudulento: esa
decisión la toma la API combinando señales y validaciones externas. Cada
hallazgo trae `confidence` y `evidence` con las mediciones crudas.

**Límites generales**
- Una foto o un escaneo **no permite verificar** hologramas, tintas UV o
  ópticamente variables, microimpresión, relieve, el chip del DNIe ni la textura
  del papel. Estas medidas de seguridad física requieren el documento en mano.
- Un documento fabricado desde cero, de forma coherente, puede no disparar
  ninguna señal forense. Las reglas de consistencia y las validaciones externas
  (SUNAT, RENIEC) son las que lo detectan.

### Calidad de imagen (`image.*`, capa `quality`)

| Código                     | Qué significa | Límites |
|----------------------------|---------------|---------|
| `image.blur`               | Varianza del laplaciano < 100, medida sobre la imagen reducida a 1600 px. | Depende del contenido: una página casi en blanco puede marcar bajo aunque esté nítida. |
| `image.low_resolution`     | Lado menor < 600 px o < 0,4 MP. | — |
| `image.glare`              | 2–60 % de píxeles ≥ 250 **y** concentrados (alguna celda de una grilla 8×8 con > 50 % saturado). | Se excluye a propósito el papel blanco escaneado (saturación casi total). |
| `image.too_dark`           | Brillo medio < 0,25. | — |
| `image.no_camera_metadata` | (info) No es JPEG y no trae EXIF: posible captura de pantalla o exportación. | Muchas apps quitan el EXIF legítimamente. |

`quality.contrast` es la desviación estándar de la luminancia (0..1). `dhash` es
un hash perceptual de 64 bits sobre la imagen ya orientada según EXIF.
`ukuk_forensics::hamming(a, b)` da la distancia entre dos dHash. Una distancia
≤ 6 suele indicar la misma imagen recomprimida o reescalada, útil para detectar
documentos reutilizados.

### Forense de imagen (`ela.*`, `copy_move.*`, `exif.*`)

- **`ela.inconsistent_compression`**: se recomprime a JPEG q=90 y se mide la
  diferencia media por bloque de 16 px. Un bloque se marca si supera *media + 3σ*,
  un piso absoluto (2,0) y 2,5 veces la media. Además debe ser atípico (z robusto > 3,5)
  frente a los bloques de **textura similar** (deciles de gradiente). Esto evita
  marcar simplemente "donde hay texto". Los bloques contiguos se fusionan en
  regiones (mínimo 2 bloques), y se informan hasta 5.
  Confianza ≤ 0,6. Si el archivo no es JPEG, la severidad es baja y la
  confianza 0,25.
  *Límites*: el ELA es ruidoso. Cuando el fondo ya tenía errores de
  recompresión similares (p. ej. texto guardado a baja calidad y luego a alta),
  un pegado no se distingue. Los reescalados y filtros borran la señal, y los
  bordes de alto contraste pueden generar falsos positivos.
- **`copy_move.duplicated_region`**: bloques solapados de 8×8 no planos, con una
  firma cuantizada (16 celdas 2×2, 4 bits cada una). Se agrupan los pares idénticos
  por vector de desplazamiento y se exigen ≥ 64 bloques con el mismo vector
  (y una distancia ≥ 24 px). Las firmas que se repiten más de 8 veces se
  descartan, porque corresponden a tramas, líneas o rayas.
  *Límites*: no detecta clones rotados, escalados o muy recomprimidos. Las
  imágenes de más de 1024 px se analizan reducidas. Un texto digital
  muy repetido (misma palabra renderizada idéntica) podría coincidir.
- **`exif.editing_software`**: el tag `Software` (o `xmp:CreatorTool`) menciona un
  editor. Photoshop, GIMP, Photopea, Canva, PicsArt y similares dan severidad alta.
  Lightroom, Snapseed y otros editores de ajuste dan severidad media.
  Se informan `has_gps` y `datetime_original`.
  *Límites*: el EXIF se borra o falsifica con facilidad. Su ausencia no prueba nada.

### PDF (`pdf.*`, `file.password_protected`)

Análisis estructural sobre los bytes, sin renderizar. Los flujos FlateDecode se
descomprimen con tope (16 MB por flujo, 96 MB en total) para ver los objetos
dentro de los flujos de objetos.

| Código | Qué significa |
|--------|---------------|
| `pdf.editing_software` | `Producer`/`Creator` (o XMP) menciona un editor: iLovePDF, Smallpdf, Sejda, PDFescape, Foxit PhantomPDF/Editor, PDF-XChange, PDFelement, Nitro, Adobe Acrobat (sin contar Distiller/PDFMaker), etc. |
| `pdf.word_processor_origin` | Un comprobante que debería salir de un sistema (`factura`, `boleta_venta`, `boleta_pago`, `recibo_servicio`) fue generado con Word, Excel, LibreOffice, etc. |
| `pdf.modified_after_creation` | `ModDate` es posterior a `CreationDate` por más de 2 minutos. |
| `pdf.incremental_update` | Hay más de un `%%EOF` (sin contar el de linealización): se agregó contenido después de guardar. Es *info* si coincide con firmas digitales (`/ByteRange`). |
| `pdf.encrypted` | Cifrado con contraseña de usuario vacía: se abre sin contraseña, pero tiene restricciones. |
| `file.password_protected` | Exige contraseña para abrirse, o usa un cifrado no estándar. Siempre se marca, con severidad alta. Se verifica la contraseña vacía para R2–R6 (RC4, AES-128, AES-256). |
| `pdf.javascript` | Contiene `/JavaScript` o `/JS`. |
| `pdf.mixed_fonts` | Más de 6 familias tipográficas distintas. |
| `pdf.no_text_layer` | Comprobante "de sistema" sin capa de texto (escaneado o rasterizado). |

*Límites*: no se valida la firma digital. Los metadatos pueden falsificarse, y un
editor cuidadoso puede reescribir el archivo completo sin dejar actualizaciones
incrementales. `pages` sale del `/Count` del árbol de páginas.

### XML SUNAT (`xml.*`)

Detecta UBL `Invoice`, `CreditNote` y `DebitNote` (espacio de nombres OASIS UBL),
la presencia de `ds:Signature` y extrae:

- RUC emisor (`AccountingSupplierParty/Party/PartyIdentification/ID`, o el
  `CustomerAssignedAccountID` de UBL 2.0)
- serie-número (`cbc:ID`)
- total (`LegalMonetaryTotal/PayableAmount`)
- fecha de emisión

Con `fields`, compara cada valor y emite `xml.mismatch_with_pdf`. La comparación
tolera ceros a la izquierda en el correlativo, los formatos de fecha y una
diferencia de ±0,01 en montos.

*Límites*: la firma no se valida criptográficamente. Para confirmar que el
comprobante existe hay que consultar a SUNAT (lo hace la API). Las entidades
externas del XML no se expanden.

### Disposición OCR (`layout.*`)

Las palabras se agrupan en líneas por solapamiento vertical. Para cada palabra se
estima el tamaño de letra y la línea base a partir de su caja y sus glifos:
mayúsculas/ascendentes vs. altura x, y descendentes `gjpqy`. Así "Pago" o "mes" no
se confunden con texto movido.

- **`layout.misaligned_text`**: la línea base de la palabra se desvía más del 25 % del
  tamaño de letra respecto de la mediana de su línea (líneas de ≥ 3 palabras).
- **`layout.font_size_outlier`**: el tamaño relativo a su línea es atípico frente al
  documento (z robusto con MAD > 3,5 y diferencia > 15 %).

*Límites*: depende de la calidad de las cajas del OCR. Las fotos con perspectiva o
curvatura fuerte pueden generar falsos positivos, y los títulos o celdas de tabla con
otro tamaño de letra en la misma línea también pueden marcarse.

### Plantillas (`template.*`)

Cada ancla se busca por texto normalizado: exacto, o contenido en ventanas de
palabras consecutivas. Se mide el desplazamiento de su centro respecto de la
posición esperada. Con 3 o más anclas encontradas se descuenta el desplazamiento
global (mediana), de modo que un encuadre distinto de la foto no dispare alertas.

| Código | Qué significa |
|--------|---------------|
| `template.anchor_displaced` | El desplazamiento residual supera `tolerance` (por defecto 0,03). |
| `template.anchor_missing` | No se encontró un ancla. |
| `template.mismatch` | Falta la mitad o más de las anclas. |
| `template.none` | (info) "Sin plantilla de referencia: confianza limitada". |
| `template.not_evaluated` | (info) Hay plantilla pero no hay palabras OCR. |

### Reglas peruanas (`ruc.*`, `dni.*`, `mrz.*`, `invoice.*`, `dates.*`)

- **RUC**: 11 dígitos, prefijo 10/15/16/17/20 y verificador módulo 11 con pesos
  5,4,3,2,7,6,5,4,3,2 (r = 11 − suma mod 11; 10→0, 11→1). Emite `ruc.invalid`
  (`evidence.reason`: `format`, `prefix` o `check_digit`). Que el RUC sea válido no
  significa que esté activo o habido: eso lo consulta la API en SUNAT.
- **DNI**: 8 dígitos (`dni.invalid_format`).
- **MRZ TD1** (ICAO 9303):
  - Dígitos de control con pesos 7,3,1 para número, nacimiento, vencimiento y
    compuesto (`mrz.check_digit_*`).
  - Número de documento extendido (más de 9 caracteres). El DNI se toma del
    número `12345678<` o de los datos opcionales.
  - Siglo: el nacimiento siempre queda en el pasado, y el vencimiento en una ventana
    de ±50 años.
  - Si el OCR recorta los rellenos finales, se rellenan con `<` (`mrz.padded`).
  - `mrz.invalid_format`, `mrz.invalid_characters`, `mrz.invalid_date`, `mrz.expired`.
  - Cruce con los campos impresos, insensible a tildes. Acepta truncamiento de
    nombres largos y la transliteración `NXX`=Ñ: `mrz.dni_mismatch`,
    `mrz.surname_mismatch`, `mrz.given_names_mismatch`,
    `mrz.birth_date_mismatch`, `mrz.expiry_date_mismatch`, `mrz.sex_mismatch`.
  - Una MRZ válida solo prueba que es coherente consigo misma: se puede generar
    con una calculadora.
- **Comprobantes**:
  - `invoice.totals_mismatch`: subtotal + IGV ≠ total (± 0,02).
  - `invoice.igv_rate_mismatch`: el IGV no es el 18 % ni el 10,5 % del subtotal. La
    tolerancia es max(0,02; 0,05 % del subtotal).
  - Informativos: `invoice.igv_reduced_rate` (MYPE de restaurantes y hoteles) e
    `invoice.igv_zero` (exonerado o inafecto).
  - `invoice.items_mismatch`: la suma de ítems no coincide con el subtotal (tampoco
    con el total).
  - `invoice.serie_format`: formato `[FBE]XXX-NNNNNNNN`. La factura debe empezar con
    F/E y la boleta con B/E. No se aplica a `recibo_servicio`, porque las empresas de
    servicios usan otras series (`S001`…).
  - `invoice.unparseable_amount`.
- **Fechas**:
  - `dates.invalid_date`: fechas imposibles como 2026-02-30.
  - `dates.unparseable`.
  - `dates.future_issue`, `dates.future_birth`, `dates.expiry_before_issue`,
    `dates.birth_after_issue`, `dates.implausible_birth` (edad > 120 años).
  - `dates.document_expired` (solo DNI; se omite si ya se emitió `mrz.expired`).
  - "NO CADUCA" no se marca.
  - La fecha de referencia es la de Lima (UTC−5).

## Listas de vigilancia y coincidencia de nombres

**Normalización**:

- mayúsculas, NFD sin tildes (Ñ→N), signos eliminados y espacios colapsados;
- la forma `APELLIDOS, Nombres` se reordena;
- las partículas (DE, DEL, DE LA, DE LOS, DE LAS, LA, LAS, LOS, Y, VDA, VDA DE,
  VIUDA DE) se conservan para mostrar pero no puntúan; en cambio, "DE LA CRUZ"
  también se compara como "DELACRUZ";
- se ignoran las formas societarias finales (S.A.C., S.A., SRL, EIRL…).

**Clave fonética española** (para el bloqueo): B/V/W→B, Z y C(e,i)→S,
C/QU/K→K, CH→X, LL/Y→Y, H muda, G(e,i)/J→J, GU(e,i)→G, PH→F, X→KS, y las letras
dobles se colapsan.

**Puntaje**:

- **Asignación de tokens sin orden.** Para cada par de tokens se calcula la
  similitud como el promedio de Jaro-Winkler (`strsim`) y Damerau-Levenshtein
  normalizado. JW solo sobrevalora prefijos comunes, como CASTILLO/CASTRO.
- **Mismo sonido.** Dos tokens con la misma clave fonética valen al menos 0,95.
- **Iniciales.** Valen 0,7.
- **Tokens sin pareja.** Se penalizan según su longitud: al 100 % en el nombre con
  menos tokens y al 35 % en el más largo, porque es normal omitir el segundo
  apellido.
- **Fecha de nacimiento.** Si coincide (fecha completa, o solo año cuando la lista
  solo tiene el año) suma +0,03, con tope en 1. Si es distinta resta 0,15.
- **Tipo.** Un tipo distinto (individuo o entidad) resta 0,05.
- **`reasons`.** Explica el puntaje, p. ej. `tokens: 3/4`,
  `jaro_winkler: 0.96`, `fecha de nacimiento coincide`.

**Índice**: hay un índice invertido por clave fonética, con un vocabulario de tokens
compartido y una caché de similitudes por consulta. Solo se puntúan los nombres
que comparten claves con al menos la mitad de los tokens de la consulta. Medición
de referencia (release, 4 núcleos): **100 000 sujetos contra 30 000 entradas en
unos 15 s**, con datos sintéticos de vocabulario muy pobre (40 apellidos y 30
nombres, el peor caso para el bloqueo). Con listas reales el tiempo debería ser
bastante menor (no medido).

*Límites*: un error de tipeo que cambie la clave fonética de **todos** los tokens
no se encuentra (bloqueo). Tampoco se transliteran alfabetos no latinos.

**Formatos**:

- **`ofac_sdn_csv`**: `sdn.csv` sin cabecera, aunque se tolera una. `-0-` se toma
  como vacío. De `Remarks` se extraen `DOB …`, `nationality …` (convertida a ISO-2
  cuando se reconoce) y los alias `a.k.a. '…'` / `f.k.a. '…'`.
- **`un_xml`**: lista consolidada de la ONU, con `INDIVIDUAL`, `ENTITY`, alias,
  fechas (`DATE`, `YEAR`, `FROM_YEAR`, `TO_YEAR`) y nacionalidades.
- **`ukuk_jsonl`**: una entrada JSON por línea. Un error informa el número de línea.

## Desarrollo

```bash
cargo test --workspace
cargo clippy --all-targets -- -D warnings
cargo fmt --all
# Prueba de rendimiento (no corre por defecto):
cargo test --release -p ukuk-names --test parsers -- --ignored batch_100k --nocapture
```

| Crate            | Contenido |
|------------------|-----------|
| `ukuk-core`      | Tipos compartidos: `Finding`, `Region`, `OcrWord`, `DocumentFields`, `DocumentType`. |
| `ukuk-peru`      | Reglas puras y deterministas (RUC, DNI, MRZ, comprobantes, fechas). `mrz::testing::build_td1` genera MRZ válidas. |
| `ukuk-forensics` | Imagen (calidad, dHash, ELA, copy-move, EXIF), PDF, XML UBL, disposición OCR, plantillas. |
| `ukuk-names`     | Normalización, clave fonética, puntaje, índice y parsers de listas (fixtures ficticios en `tests/fixtures`). |
| `ukuk-engine`    | Binario axum + pruebas de integración HTTP (`tests/api.rs`). |

Las imágenes de prueba se generan por programa: ruido y texturas con LCG,
desenfoque, parches pegados con otra historia de compresión y bloques clonados.
Las MRZ de prueba se construyen calculando los dígitos de control.
