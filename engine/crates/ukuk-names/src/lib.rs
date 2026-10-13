//! Coincidencia de nombres pensada para nombres peruanos (dos apellidos,
//! partículas, orden libre, errores de tipeo) y listas de vigilancia indexadas.

pub mod index;
pub mod model;
pub mod normalize;
pub mod parsers;
pub mod phonetic;
pub mod score;

pub use index::{IndexedList, ScreenMatch, ScreenQuery, screen, screen_batch};
pub use model::{Category, Entry, EntryKind, ListFormat, ListMeta};
pub use normalize::{PreparedName, normalize, prepare};
pub use parsers::{ParseError, parse};
pub use score::{NameScore, name_similarity};
