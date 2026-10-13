use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use ukuk_names::IndexedList;

use crate::persist;

/// Estado compartido: solo las listas de vigilancia (el motor no guarda documentos).
#[derive(Clone, Default)]
pub struct AppState {
    pub watchlists: Arc<RwLock<BTreeMap<String, Arc<IndexedList>>>>,
    pub data_dir: Option<PathBuf>,
}

impl AppState {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            watchlists: Arc::default(),
            data_dir,
        }
    }

    /// Crea el estado y recarga las listas persistidas en `data_dir`.
    pub async fn load(data_dir: Option<PathBuf>) -> Self {
        let state = Self::new(data_dir.clone());
        if let Some(dir) = data_dir {
            let lists = tokio::task::spawn_blocking(move || persist::load_all(&dir))
                .await
                .unwrap_or_default();
            let mut guard = state.watchlists.write().unwrap_or_else(|e| e.into_inner());
            for list in lists {
                tracing::info!(source = %list.meta.source, entries = list.meta.entries, "lista recargada");
                guard.insert(list.meta.source.clone(), Arc::new(list));
            }
        }
        state
    }

    /// Copia de las listas (para trabajar sin mantener el candado).
    pub fn snapshot(&self) -> Vec<Arc<IndexedList>> {
        self.watchlists
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }
}
