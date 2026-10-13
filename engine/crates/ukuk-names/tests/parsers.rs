use std::sync::Arc;
use std::time::Instant;

use ukuk_names::{
    Category, Entry, EntryKind, IndexedList, ListFormat, ListMeta, ScreenQuery, parse, screen,
    screen_batch,
};

const SDN: &[u8] = include_bytes!("fixtures/sdn_sample.csv");
const UN: &[u8] = include_bytes!("fixtures/un_sample.xml");
const PEP: &[u8] = include_bytes!("fixtures/pep_sample.jsonl");

fn meta(source: &str, category: Category, n: usize) -> ListMeta {
    ListMeta {
        source: source.into(),
        category,
        entries: n,
        version: "test".into(),
        loaded_at: "2026-10-13T00:00:00Z".into(),
    }
}

fn indexed(source: &str, format: ListFormat, raw: &[u8], category: Category) -> Arc<IndexedList> {
    let entries = parse(format, raw).expect("parse");
    Arc::new(IndexedList::build(
        meta(source, category, entries.len()),
        entries,
    ))
}

fn query(name: &str) -> ScreenQuery {
    ScreenQuery {
        name: name.into(),
        ..Default::default()
    }
}

#[test]
fn parses_ofac_sdn_csv() {
    let e = parse(ListFormat::OfacSdnCsv, SDN).unwrap();
    assert_eq!(e.len(), 6);
    let teo = &e[0];
    assert_eq!(teo.id, "9001");
    assert_eq!(teo.kind, Some(EntryKind::Individual));
    assert_eq!(teo.birth_dates, vec!["1968-03-14"]);
    assert_eq!(teo.nationalities, vec!["PE"]);
    assert_eq!(teo.aliases, vec!["TIO TEO"]);
    assert_eq!(e[1].programs, vec!["SDNTK", "ILLICIT-DRUGS"]);
    assert_eq!(e[1].birth_dates, vec!["1970-02-03", "1971"]);
    assert_eq!(e[2].kind, Some(EntryKind::Entity));
    assert!(e[2].birth_dates.is_empty());
    assert_eq!(e[3].kind, Some(EntryKind::Entity));
    assert!(e[3].remarks.as_deref().unwrap().starts_with("[vessel]"));
    assert_eq!(e[4].birth_dates, vec!["1975"]);
    assert_eq!(e[4].nationalities, vec!["BO"]);
    assert_eq!(e[4].aliases, vec!["ERNESTINA QUELCA"]);
    assert_eq!(e[5].remarks, None);
}

#[test]
fn ofac_with_header_row() {
    let mut raw = b"ent_num,SDN_Name,SDN_Type,Program,Title,Call_Sign,Vess_type,Tonnage,GRT,Vess_flag,Vess_owner,Remarks\n".to_vec();
    raw.extend_from_slice(SDN);
    assert_eq!(parse(ListFormat::OfacSdnCsv, &raw).unwrap().len(), 6);
}

#[test]
fn parses_un_xml() {
    let e = parse(ListFormat::UnXml, UN).unwrap();
    assert_eq!(e.len(), 3);
    let abel = &e[0];
    assert_eq!(abel.id, "7000001");
    assert_eq!(abel.name, "ABELARDO CONDORCANQUI MALLMA");
    assert_eq!(abel.aliases, vec!["Camarada Abel"]);
    assert_eq!(abel.birth_dates, vec!["1962-11-04", "1963"]);
    assert_eq!(abel.nationalities, vec!["PE"]);
    assert_eq!(abel.programs, vec!["Ficticia"]);
    assert_eq!(
        abel.remarks.as_deref(),
        Some("XXi.001: Entrada ficticia para pruebas & validación.")
    );
    assert_eq!(e[1].name, "MARÍA ESTHER YUPANQUI HUILLCA");
    assert_eq!(e[1].birth_dates, vec!["1970", "1972"]);
    assert_eq!(e[2].kind, Some(EntryKind::Entity));
    assert_eq!(e[2].aliases, vec!["FACN", "Condor Negro"]);
}

#[test]
fn parses_jsonl() {
    let e = parse(ListFormat::UkukJsonl, PEP).unwrap();
    assert_eq!(e.len(), 3);
    assert_eq!(e[0].aliases, vec!["Gumer Ccahuana"]);
    assert_eq!(e[2].kind, Some(EntryKind::Entity));
}

#[test]
fn rejects_bad_inputs() {
    let err = parse(
        ListFormat::UkukJsonl,
        b"{\"id\":\"1\",\"name\":\"A\"}\n{oops",
    )
    .unwrap_err();
    assert!(err.to_string().contains("línea 2"), "{err}");
    assert!(parse(ListFormat::UkukJsonl, b"{\"id\":\"\",\"name\":\"A\"}").is_err());
    assert!(parse(ListFormat::UnXml, b"<CONSOLIDATED_LIST><INDIVIDUALS></x>").is_err());
    assert!(parse(ListFormat::UnXml, b"<CONSOLIDATED_LIST/>").is_err());
    assert!(parse(ListFormat::OfacSdnCsv, b"").is_err());
}

#[test]
fn screens_across_lists() {
    let lists = vec![
        indexed("ofac_sdn", ListFormat::OfacSdnCsv, SDN, Category::Sanction),
        indexed("un", ListFormat::UnXml, UN, Category::Sanction),
        indexed("pep_pe", ListFormat::UkukJsonl, PEP, Category::Pep),
    ];
    let m = screen(&lists, &query("Teódulfo Huamanchumo Saravia"));
    assert_eq!(m[0].entry_id, "9001");
    assert_eq!(m[0].source, "ofac_sdn");

    let m = screen(&lists, &query("Maria Esther Yupanqui Huillca"));
    assert_eq!(m[0].source, "un");

    let m = screen(&lists, &query("Gumersindo Ccahuana Tello"));
    assert_eq!(m[0].entry_id, "pep-001");
    assert_eq!(m[0].category, Category::Pep);

    let m = screen(&lists, &query("Rosaura Villavicencio Delapuente"));
    assert_eq!(m[0].entry_id, "pep-002");

    let m = screen(&lists, &query("Ernestina Quelca"));
    assert_eq!(m[0].entry_id, "9005");

    let mut q = query("Inversiones Maquisapa del Oriente SAC");
    q.kind = Some(EntryKind::Entity);
    let m = screen(&lists, &q);
    assert_eq!(m[0].entry_id, "9003");
    assert_eq!(m[0].score, 1.0);

    let mut q = query("Juan Pérez de la Cruz");
    q.sources = Some(vec!["un".into()]);
    assert!(screen(&lists, &q).is_empty());
}

/// Entradas sintéticas reproducibles (LCG) a partir de nombres y apellidos frecuentes.
fn synthetic_entries(n: usize, seed: u64) -> Vec<Entry> {
    const GIVEN: &[&str] = &[
        "JUAN", "JOSE", "LUIS", "CARLOS", "JORGE", "MIGUEL", "PEDRO", "VICTOR", "CESAR", "MARIA",
        "ROSA", "ANA", "CARMEN", "JULIA", "ELENA", "LUZ", "SONIA", "GLADYS", "WILBER", "EDWIN",
        "FREDY", "NANCY", "MARCO", "RAUL", "HUGO", "PERCY", "YOLANDA", "HILDA", "OSCAR", "ELMER",
    ];
    const SURNAMES: &[&str] = &[
        "QUISPE",
        "FLORES",
        "SANCHEZ",
        "RODRIGUEZ",
        "GARCIA",
        "HUAMAN",
        "MAMANI",
        "CHAVEZ",
        "RAMOS",
        "TORRES",
        "DIAZ",
        "CASTILLO",
        "VASQUEZ",
        "MENDOZA",
        "ROJAS",
        "GUTIERREZ",
        "ESPINOZA",
        "LOPEZ",
        "PEREZ",
        "CRUZ",
        "CONDORI",
        "TICONA",
        "APAZA",
        "CCAHUANA",
        "HUANCA",
        "VILCA",
        "PUMA",
        "CUSI",
        "TAIPE",
        "YUPANQUI",
        "CHOQUE",
        "SALAZAR",
        "MORALES",
        "VARGAS",
        "LEON",
        "SILVA",
        "CAMPOS",
        "REYES",
        "CORDOVA",
        "PAREDES",
    ];
    let mut state = seed;
    let mut next = |m: usize| {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 33) as usize) % m
    };
    (0..n)
        .map(|i| Entry {
            id: format!("syn-{i}"),
            name: format!(
                "{} {}, {} {}",
                SURNAMES[next(SURNAMES.len())],
                SURNAMES[next(SURNAMES.len())],
                GIVEN[next(GIVEN.len())],
                GIVEN[next(GIVEN.len())]
            ),
            kind: Some(EntryKind::Individual),
            ..Default::default()
        })
        .collect()
}

fn batch_perf(subjects: usize, entries: usize) -> std::time::Duration {
    let list = Arc::new(IndexedList::build(
        meta("syn", Category::Sanction, entries),
        synthetic_entries(entries, 7),
    ));
    let queries: Vec<ScreenQuery> = synthetic_entries(subjects, 99)
        .into_iter()
        .map(|e| query(&e.name))
        .collect();
    let start = Instant::now();
    let results = screen_batch(&[list], &queries);
    let elapsed = start.elapsed();
    assert_eq!(results.len(), subjects);
    elapsed
}

#[test]
fn batch_screening_is_fast_enough() {
    // Escala reducida en modo debug; la prueba completa está en `batch_100k_vs_30k`.
    let elapsed = batch_perf(1_000, 30_000);
    assert!(elapsed.as_secs() < 30, "{elapsed:?}");
}

/// `cargo test --release -p ukuk-names -- --ignored batch_100k --nocapture`
#[test]
#[ignore]
fn batch_100k_vs_30k() {
    let elapsed = batch_perf(100_000, 30_000);
    println!("100k sujetos × 30k entradas: {elapsed:?}");
}
