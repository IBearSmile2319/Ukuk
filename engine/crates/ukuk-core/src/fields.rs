use serde::{Deserialize, Deserializer, Serialize};

/// Tipo de documento declarado por la API. Valores desconocidos caen en `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DocumentType {
    Dni,
    BoletaPago,
    ReciboServicio,
    Factura,
    BoletaVenta,
    InformeMedico,
    Receta,
    Acta,
    Certificado,
    #[default]
    #[serde(other)]
    Other,
}

impl DocumentType {
    /// Documentos que normalmente emite un sistema (facturador, planilla, empresa
    /// de servicios), por lo que un PDF salido de un procesador de texto es raro.
    pub fn is_system_generated(self) -> bool {
        matches!(
            self,
            Self::Factura | Self::BoletaVenta | Self::BoletaPago | Self::ReciboServicio
        )
    }
}

/// Campos impresos ya extraídos por la API. Todos opcionales.
/// Los montos se aceptan como texto o como número JSON.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentFields {
    pub dni: Option<String>,
    pub apellidos: Option<String>,
    pub nombres: Option<String>,
    pub fecha_nacimiento: Option<String>,
    pub fecha_vencimiento: Option<String>,
    pub sexo: Option<String>,
    pub mrz: Option<String>,
    pub ruc_emisor: Option<String>,
    pub serie_numero: Option<String>,
    pub fecha_emision: Option<String>,
    #[serde(deserialize_with = "string_or_number")]
    pub subtotal: Option<String>,
    #[serde(deserialize_with = "string_or_number")]
    pub igv: Option<String>,
    #[serde(deserialize_with = "string_or_number")]
    pub total: Option<String>,
    #[serde(deserialize_with = "string_or_number")]
    pub items_total: Option<String>,
}

fn string_or_number<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        Some(other) => {
            return Err(serde::de::Error::custom(format!(
                "se esperaba texto o número, se recibió {other}"
            )));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_document_type_is_other() {
        let t: DocumentType = serde_json::from_str("\"pasaporte\"").unwrap();
        assert_eq!(t, DocumentType::Other);
        let t: DocumentType = serde_json::from_str("\"boleta_venta\"").unwrap();
        assert_eq!(t, DocumentType::BoletaVenta);
    }

    #[test]
    fn amounts_accept_numbers_and_strings() {
        let f: DocumentFields =
            serde_json::from_str(r#"{"subtotal":100,"igv":"18.00","total":118.5}"#).unwrap();
        assert_eq!(f.subtotal.as_deref(), Some("100"));
        assert_eq!(f.igv.as_deref(), Some("18.00"));
        assert_eq!(f.total.as_deref(), Some("118.5"));
        assert!(f.items_total.is_none());
    }

    #[test]
    fn amounts_reject_objects() {
        assert!(serde_json::from_str::<DocumentFields>(r#"{"total":{}}"#).is_err());
    }
}
