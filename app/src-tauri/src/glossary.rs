//! Local, per-book glossary shared by the webview commands and reader MCP tools.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 1_000;
const MAX_PAGE: usize = 1_000_000;
const MAX_FILE_BYTES: u64 = 64_000_000;
const MAX_DATE: u64 = 8_640_000_000_000_000;
static WRITES: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub term: String,
    #[serde(default)]
    pub latex: String,
    pub explanation: String,
    pub page: usize,
    pub date: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryInput {
    pub term: String,
    #[serde(default)]
    pub latex: String,
    pub explanation: String,
    pub page: usize,
}

pub fn glossary_path(index: &Path) -> PathBuf {
    index.with_extension("glossary.json")
}

fn validate(term: &str, latex: &str, explanation: &str, page: usize) -> Result<(), String> {
    if term.trim().is_empty() || term.chars().count() > 200 {
        return Err("Le terme doit contenir de 1 à 200 caractères.".into());
    }
    if latex.chars().count() > 2_000 {
        return Err("Le LaTeX est limité à 2 000 caractères.".into());
    }
    if explanation.trim().is_empty() || explanation.chars().count() > 8_000 {
        return Err("L'explication doit contenir de 1 à 8 000 caractères.".into());
    }
    if page == 0 || page > MAX_PAGE {
        return Err("La page ou section doit être comprise entre 1 et 1 000 000.".into());
    }
    Ok(())
}

pub fn load(index: &Path) -> Result<Vec<Entry>, String> {
    let path = glossary_path(index);
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Glossaire illisible : {e}")),
    };
    let mut raw = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|e| format!("Glossaire illisible : {e}"))?;
    if raw.len() as u64 > MAX_FILE_BYTES {
        return Err("Le fichier du glossaire est trop volumineux.".into());
    }
    let entries: Vec<Entry> =
        serde_json::from_slice(&raw).map_err(|e| format!("Glossaire illisible : {e}"))?;
    if entries.len() > MAX_ENTRIES {
        return Err("Le glossaire dépasse la limite de 1 000 entrées.".into());
    }
    let mut identities = std::collections::HashSet::new();
    for entry in &entries {
        validate(&entry.term, &entry.latex, &entry.explanation, entry.page)?;
        if entry.date > MAX_DATE {
            return Err("Le glossaire contient une date invalide.".into());
        }
        if !identities.insert((entry.term.trim(), entry.page)) {
            return Err("Le glossaire contient une entrée en double.".into());
        }
    }
    Ok(entries)
}

fn validate_book_page(index: &Path, page: usize) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Bounds {
        #[serde(rename = "pageCount")]
        page_count: usize,
    }
    let raw = match fs::read(index) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Index du livre illisible : {e}")),
    };
    let bounds: Bounds =
        serde_json::from_slice(&raw).map_err(|e| format!("Index du livre illisible : {e}"))?;
    if page > bounds.page_count {
        return Err(format!(
            "La page ou section {page} dépasse les {} du livre.",
            bounds.page_count
        ));
    }
    Ok(())
}

/// The persistent lock file must never be unlinked: all processes lock the same inode.
pub fn add(index: &Path, input: EntryInput) -> Result<Vec<Entry>, String> {
    validate(&input.term, &input.latex, &input.explanation, input.page)?;
    let path = glossary_path(index);
    let dir = path.parent().ok_or("Chemin du glossaire invalide.")?;
    fs::create_dir_all(dir).map_err(|e| format!("Dossier du glossaire inaccessible : {e}"))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("json.lock"))
        .map_err(|e| format!("Verrou du glossaire inaccessible : {e}"))?;
    lock.lock_exclusive()
        .map_err(|e| format!("Verrou du glossaire inaccessible : {e}"))?;
    validate_book_page(index, input.page)?;
    let mut entries = load(index)?;
    let term = input.term.trim().to_string();
    let existing = entries
        .iter()
        .position(|entry| entry.term.trim() == term && entry.page == input.page);
    if existing.is_none() && entries.len() >= MAX_ENTRIES {
        return Err("Le glossaire est limité à 1 000 entrées.".into());
    }
    let date = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Date du glossaire invalide : {e}"))?
        .as_millis() as u64;
    let entry = Entry {
        term,
        latex: input.latex.trim().into(),
        explanation: input.explanation.trim().into(),
        page: input.page,
        date,
    };
    match existing {
        Some(at) => entries[at] = entry,
        None => entries.push(entry),
    }
    let content =
        serde_json::to_vec_pretty(&entries).map_err(|e| format!("Glossaire invalide : {e}"))?;
    let partial = path.with_extension(format!(
        "json.{}.{}.part",
        std::process::id(),
        WRITES.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
        .map_err(|e| format!("Enregistrement du glossaire impossible : {e}"))?;
    let result = (|| {
        file.write_all(&content)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Enregistrement du glossaire impossible : {e}"))?;
        fs::rename(&partial, &path)
            .map_err(|e| format!("Enregistrement du glossaire impossible : {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "marginalia-glossary-{}-{}",
            std::process::id(),
            WRITES.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(term: &str, page: usize) -> EntryInput {
        EntryInput {
            term: term.into(),
            latex: "".into(),
            explanation: "Définition".into(),
            page,
        }
    }

    #[test]
    fn persists_upserts_case_and_distinct_senses_per_book() {
        let dir = dir();
        let index = dir.join("book.json");
        assert!(load(&index).unwrap().is_empty());
        let entries = add(&index, entry(" ⊤ ", 2)).unwrap();
        assert_eq!(entries[0].term, "⊤");
        assert!(entries[0].date > 1_000_000_000_000);
        let mut changed = entry("⊤", 2);
        changed.explanation = "Nouvelle définition".into();
        assert_eq!(add(&index, changed).unwrap().len(), 1);
        add(&index, entry("⊤", 8)).unwrap();
        add(&index, entry("X", 2)).unwrap();
        add(&index, entry("x", 2)).unwrap();
        let loaded = load(&index).unwrap();
        assert_eq!(loaded.len(), 4);
        assert_eq!(loaded[0].explanation, "Nouvelle définition");
        assert!(load(&dir.join("other.json")).unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_invalid_inputs_and_known_bounds_even_for_partial_index() {
        let dir = dir();
        let index = dir.join("book.json");
        fs::write(&index, r#"{"pageCount":12,"complete":false}"#).unwrap();
        for invalid in [
            entry("", 1),
            entry("x", 0),
            entry("x", 13),
            entry(&"x".repeat(201), 1),
        ] {
            assert!(add(&index, invalid).is_err());
        }
        let mut invalid = entry("x", 1);
        invalid.explanation = " ".into();
        assert!(add(&index, invalid).is_err());
        let mut invalid = entry("x", 1);
        invalid.latex = "x".repeat(2001);
        assert!(add(&index, invalid).is_err());
        let mut invalid = entry("x", 1);
        invalid.explanation = "x".repeat(8001);
        assert!(add(&index, invalid).is_err());
        assert!(load(&index).unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preserves_corrupt_bytes_and_invalid_stored_entries() {
        let dir = dir();
        let index = dir.join("book.json");
        for bytes in [
            b"{broken".as_slice(),
            br#"[{"term":"","latex":"","explanation":"x","page":1,"date":0}]"#.as_slice(),
        ] {
            fs::write(glossary_path(&index), bytes).unwrap();
            assert!(load(&index).is_err());
            assert!(add(&index, entry("x", 1)).is_err());
            assert_eq!(fs::read(glossary_path(&index)).unwrap(), bytes);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_unknown_fields_and_dates_outside_javascript_range() {
        let dir = dir();
        let index = dir.join("book.json");
        for raw in [
            r#"[{"term":"x","explanation":"definition","page":1,"date":8640000000000001}]"#,
            r#"[{"term":"x","explanation":"definition","page":1,"date":0,"extra":true}]"#,
        ] {
            fs::write(glossary_path(&index), raw).unwrap();
            assert!(load(&index).is_err());
            assert!(add(&index, entry("x", 1)).is_err());
            assert_eq!(fs::read_to_string(glossary_path(&index)).unwrap(), raw);
        }
        let invalid = r#"{"term":"x","explanation":"definition","page":1,"extra":true}"#;
        assert!(serde_json::from_str::<EntryInput>(invalid).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_writers_preserve_every_entry() {
        let dir = dir();
        let index = dir.join("book.json");
        std::thread::scope(|scope| {
            for n in 0..24 {
                let index = &index;
                scope.spawn(move || {
                    add(index, entry(&format!("term {n}"), 1)).unwrap();
                });
            }
        });
        assert_eq!(load(&index).unwrap().len(), 24);
        assert!(glossary_path(&index).with_extension("json.lock").exists());
        assert!(!fs::read_dir(&dir).unwrap().any(|p| p
            .unwrap()
            .path()
            .extension()
            .is_some_and(|e| e == "part")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn process_writer() {
        let Some(index) = std::env::var_os("MARGINALIA_GLOSSARY_TEST_INDEX") else {
            return;
        };
        let term = std::env::var("MARGINALIA_GLOSSARY_TEST_TERM").unwrap();
        add(Path::new(&index), entry(&term, 1)).unwrap();
    }

    #[test]
    fn independent_processes_preserve_every_entry() {
        let dir = dir();
        let index = dir.join("book.json");
        let mut processes = Vec::new();
        for n in 0..12 {
            processes.push(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "glossary::tests::process_writer"])
                    .env("MARGINALIA_GLOSSARY_TEST_INDEX", &index)
                    .env("MARGINALIA_GLOSSARY_TEST_TERM", format!("term {n}"))
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }
        for mut process in processes {
            assert!(process.wait().unwrap().success());
        }
        assert_eq!(load(&index).unwrap().len(), 12);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn permits_updates_at_entry_limit_but_refuses_new_entries() {
        let dir = dir();
        let index = dir.join("book.json");
        let entries: Vec<_> = (0..MAX_ENTRIES)
            .map(|n| Entry {
                term: format!("term {n}"),
                latex: "".into(),
                explanation: "Définition".into(),
                page: 1,
                date: 1,
            })
            .collect();
        fs::write(glossary_path(&index), serde_json::to_vec(&entries).unwrap()).unwrap();
        assert!(add(&index, entry("one too many", 1)).is_err());
        assert_eq!(add(&index, entry("term 1", 1)).unwrap().len(), MAX_ENTRIES);
        fs::remove_dir_all(dir).unwrap();
    }
}
