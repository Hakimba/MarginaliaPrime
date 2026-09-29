//! The reader's tools, served to the `claude` CLI over MCP (JSON-RPC on stdio).
//!
//! The CLI launches this very binary with `--reader-tools <index.json>` (see
//! `main.rs`): no Node, no second program to install, and the path is always
//! right since the app writes it from its own location. The process has no
//! window and never touches Tauri; it reads the book index the app wrote and
//! answers three tools: `search_book`, `get_pages`, `get_toc`.
//!
//! The index may still be under construction when the conversation starts, so
//! it is read again whenever the file changes.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::{json, Value};

/// Protocol version answered when the client asks for none we know.
const PROTOCOL_VERSION: &str = "2025-06-18";
/// Pages `get_pages` returns at most in one call.
const MAX_PAGES_PER_CALL: usize = 5;
/// Results `search_book` returns by default, and at most.
const DEFAULT_RESULTS: usize = 8;
const MAX_RESULTS: usize = 20;
/// Characters shown on each side of a match.
const SNIPPET_RADIUS: usize = 110;
/// Characters `get_pages` returns at most: a section of an EPUB is a whole
/// chapter, and five of them would flood the conversation.
const MAX_CHARS_PER_CALL: usize = 40_000;

#[derive(Deserialize, Default)]
pub struct BookIndex {
    #[serde(default)]
    pub title: String,
    /// "page" for a PDF, "section" for a reflowable book.
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub complete: bool,
    #[serde(default, rename = "pageCount")]
    pub page_count: usize,
    #[serde(default)]
    pub toc: Vec<TocEntry>,
    #[serde(default)]
    pub pages: Vec<IndexedPage>,
    /// PDF page minus the number the book prints on it, when constant.
    #[serde(skip)]
    pub printed_offset: Option<usize>,
}

#[derive(Deserialize, Clone)]
pub struct TocEntry {
    pub label: String,
    pub page: Option<usize>,
    #[serde(default)]
    pub depth: usize,
}

#[derive(Deserialize)]
pub struct IndexedPage {
    pub page: usize,
    #[serde(default)]
    pub label: Option<String>,
    pub text: String,
}

impl BookIndex {
    fn is_pdf(&self) -> bool {
        self.unit != "section"
    }

    /// "p. 208", or the section's title for a reflowable book.
    fn cite(&self, page: &IndexedPage) -> String {
        if self.is_pdf() {
            match self.printed_offset {
                Some(k) if page.page > k => {
                    format!("p. {} (imprimée {})", page.page, page.page - k)
                }
                _ => format!("p. {}", page.page),
            }
        } else {
            match &page.label {
                Some(label) if !label.is_empty() => format!("section {} « {} »", page.page, label),
                _ => format!("section {}", page.page),
            }
        }
    }

    /// Says how the book's own numbers relate to the ones to cite.
    fn numbering_note(&self) -> String {
        match self.printed_offset {
            Some(k) if self.is_pdf() => format!(
                "Numérotation : cite toujours la page du PDF, [p. N]. Le livre imprime N − {k} sur ses pages, et son propre index utilise ces numéros imprimés : ajoute {k} pour trouver la page du PDF.\n"
            ),
            _ => String::new(),
        }
    }

    /// The constant gap between a PDF page and the number printed on it, found
    /// from the numbers that open or close the pages' text (running heads and
    /// feet). None when the book prints the PDF's own numbers or no clear gap.
    pub fn detect_printed_offset(&mut self) {
        self.printed_offset = None;
        if !self.is_pdf() || self.pages.len() < 20 {
            return;
        }
        let mut gaps: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
        for page in &self.pages {
            let mut words = page.text.split_whitespace();
            let ends = [words.next(), page.text.split_whitespace().next_back()];
            let mut seen = None;
            for word in ends.into_iter().flatten() {
                if let Ok(n) = word.parse::<usize>() {
                    if n > 0 && n < page.page && seen != Some(page.page - n) {
                        seen = Some(page.page - n);
                        *gaps.entry(page.page - n).or_default() += 1;
                    }
                }
            }
        }
        if let Some((&gap, &count)) = gaps.iter().max_by_key(|(_, &c)| c) {
            if count * 3 >= self.pages.len() {
                self.printed_offset = Some(gap);
            }
        }
    }

    fn unit_plural(&self) -> &'static str {
        if self.is_pdf() {
            "pages"
        } else {
            "sections"
        }
    }
}

// ---------------------------------------------------------------------------
// Search

/// Glyphs a PDF's text layer gives for symbols it could not map, keyed by the
/// symbol. Computer Modern's big operators come out as plain capitals, its
/// extensible brackets as control characters.
fn artifact_of(c: char) -> Option<char> {
    Some(match c {
        '\u{2}' => '[',
        '\u{3}' => ']',
        '\u{10}' => '(',
        '\u{11}' => ')',
        _ => return None,
    })
}

/// Standalone capitals that stand for a big operator in a math font.
fn operator_of(token: &str) -> Option<&'static str> {
    Some(match token {
        "Z" => "∫",
        "X" => "∑",
        "Y" => "∏",
        _ => return None,
    })
}

/// A searchable copy of a page: lowercase, no whitespace, with the offset in
/// the original text of each character, so a match can be shown in context.
struct Compact {
    chars: Vec<char>,
    /// Byte offset in the original text where each character starts…
    offsets: Vec<usize>,
    /// …and where what it was read from ends: "̸ =" is one ≠.
    ends: Vec<usize>,
}

impl Compact {
    /// `repair`: also read extraction artefacts as the symbols they stand for.
    fn of(text: &str, repair: bool) -> Compact {
        let mut chars = Vec::with_capacity(text.len());
        let mut offsets = Vec::with_capacity(text.len());
        let mut ends = Vec::with_capacity(text.len());
        let mut tokens = text.char_indices().peekable();
        let mut previous_space = true;
        while let Some((at, c)) = tokens.next() {
            if c.is_whitespace() {
                previous_space = true;
                continue;
            }
            if repair {
                // A lone capital between spaces: "Z ∞" is an integral, but
                // "x ∈ Z |" is the set of integers.
                if previous_space && operator_of(&c.to_string()).is_some() {
                    let next_is_space = tokens.peek().map_or(true, |(_, n)| n.is_whitespace());
                    let next = tokens.clone().map(|(_, n)| n).find(|n| !n.is_whitespace());
                    let set_like = chars.last().is_some_and(|p| "∈∉⊂⊆⊃⊇×({,".contains(*p))
                        || next.is_some_and(|n| "|)},:;.=→×".contains(n));
                    if next_is_space && !set_like {
                        for s in operator_of(&c.to_string()).unwrap_or_default().chars() {
                            chars.push(s);
                            offsets.push(at);
                            ends.push(at + c.len_utf8());
                        }
                        previous_space = false;
                        continue;
                    }
                }
                // "̸ =" : the negation slash, then the sign it strikes.
                if c == '\u{338}' {
                    let mut look = tokens.clone();
                    while look.peek().is_some_and(|(_, n)| n.is_whitespace()) {
                        look.next();
                    }
                    if let Some(&(eq, '=')) = look.peek() {
                        look.next();
                        tokens = look;
                        chars.push('≠');
                        offsets.push(at);
                        ends.push(eq + 1);
                        previous_space = false;
                        continue;
                    }
                }
                if let Some(mapped) = artifact_of(c) {
                    chars.push(mapped);
                    offsets.push(at);
                    ends.push(at + c.len_utf8());
                    previous_space = false;
                    continue;
                }
            }
            for lower in c.to_lowercase() {
                chars.push(lower);
                offsets.push(at);
                ends.push(at + c.len_utf8());
            }
            previous_space = false;
        }
        Compact {
            chars,
            offsets,
            ends,
        }
    }

    fn find_all(&self, needle: &[char]) -> Vec<usize> {
        if needle.is_empty() || needle.len() > self.chars.len() {
            return Vec::new();
        }
        (0..=self.chars.len() - needle.len())
            .filter(|&i| self.chars[i..i + needle.len()] == *needle)
            .collect()
    }
}

/// Words around a match that say a term is being defined.
fn looks_like_definition(before: &str) -> bool {
    let lower = before.to_lowercase();
    [
        "definition",
        "define",
        "denote",
        "is called",
        "are called",
        "we call",
        "notation",
        "définition",
        "défini",
        "on appelle",
        "on note",
    ]
    .iter()
    .any(|w| lower.contains(w))
}

fn char_floor(text: &str, mut at: usize) -> usize {
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

fn char_ceil(text: &str, mut at: usize) -> usize {
    while at < text.len() && !text.is_char_boundary(at) {
        at += 1;
    }
    at
}

/// The text around a match, on one line, the match between « and ».
fn snippet(text: &str, start: usize, end: usize) -> String {
    let from = char_floor(text, start.saturating_sub(SNIPPET_RADIUS));
    let to = char_ceil(text, (end + SNIPPET_RADIUS).min(text.len()));
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "{}{} «{}» {}{}",
        if from > 0 { "…" } else { "" },
        one_line(&text[from..start]),
        one_line(&text[start..end]),
        one_line(&text[end..to]),
        if to < text.len() { "…" } else { "" },
    )
}

/// One match: a byte range of the page's original text, and whether it was
/// only found by reading extraction artefacts as symbols (a lone X is often a
/// random variable, not a sum: such a match is a guess).
#[derive(Clone, Copy)]
struct Hit {
    start: usize,
    end: usize,
    repaired: bool,
}

struct PageHits {
    index: usize,
    hits: Vec<Hit>,
    definition: bool,
    exact: bool,
}

fn hits_in(text: &str, needle_plain: &[char], needle_repaired: &[char]) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    for (repair, needle) in [(false, needle_plain), (true, needle_repaired)] {
        let compact = Compact::of(text, repair);
        for i in compact.find_all(needle) {
            let start = compact.offsets[i];
            let end = compact.ends[i + needle.len() - 1];
            if !hits
                .iter()
                .any(|h| start < h.end && h.start < end.max(start + 1))
            {
                hits.push(Hit {
                    start,
                    end,
                    repaired: repair,
                });
            }
        }
    }
    hits.sort_by_key(|h| h.start);
    hits
}

pub fn search(index: &BookIndex, query: &str, max_results: usize) -> String {
    let needle_plain = Compact::of(query, false).chars;
    let needle_repaired = Compact::of(query, true).chars;
    if needle_plain.is_empty() {
        return "Recherche vide : donne un mot, une expression ou un symbole.".to_string();
    }
    let mut pages: Vec<PageHits> = index
        .pages
        .iter()
        .enumerate()
        .filter_map(|(i, page)| {
            let hits = hits_in(&page.text, &needle_plain, &needle_repaired);
            if hits.is_empty() {
                return None;
            }
            // Only a sure match can say the page defines the term.
            let definition = hits.iter().filter(|h| !h.repaired).any(|h| {
                let from = char_floor(&page.text, h.start.saturating_sub(150));
                looks_like_definition(&page.text[from..h.start])
            });
            let exact = hits.iter().any(|h| !h.repaired);
            Some(PageHits {
                index: i,
                hits,
                definition,
                exact,
            })
        })
        .collect();

    let total: usize = pages.iter().map(|p| p.hits.len()).sum();
    let mut out = index.numbering_note();
    if !index.complete {
        out.push_str(&format!(
            "Attention : l'index du livre est encore en construction ({} {} sur {}) ; la recherche ne couvre pas encore tout le livre.\n\n",
            index.pages.len(),
            index.unit_plural(),
            index.page_count.max(index.pages.len()),
        ));
    }
    if pages.is_empty() {
        out.push_str(&format!("Aucune occurrence de « {query} » dans le livre."));
        return out;
    }
    // Sure matches first, definitions among them first, then book order.
    pages.sort_by_key(|p| (!p.exact, !p.definition, p.index));
    let shown = max_results.clamp(1, MAX_RESULTS);
    out.push_str(&format!(
        "« {query} » : {total} occurrence{} sur {} {}.\n",
        if total > 1 { "s" } else { "" },
        pages.len(),
        index.unit_plural(),
    ));
    for hit in pages.iter().take(shown) {
        let page = &index.pages[hit.index];
        out.push_str(&format!(
            "\n[{}]{}\n",
            index.cite(page),
            if hit.definition {
                " (semble définir le terme)"
            } else {
                ""
            }
        ));
        for h in hit.hits.iter().take(2) {
            out.push_str(&format!(
                "  {}{}\n",
                snippet(&page.text, h.start, h.end),
                if h.repaired {
                    " (texte abîmé lu comme le symbole : à vérifier)"
                } else {
                    ""
                }
            ));
        }
        if hit.hits.len() > 2 {
            out.push_str(&format!(
                "  (+{} autres sur cette page)\n",
                hit.hits.len() - 2
            ));
        }
    }
    if pages.len() > shown {
        let mut rest: Vec<usize> = pages[shown..]
            .iter()
            .map(|p| index.pages[p.index].page)
            .collect();
        rest.sort();
        let listed: Vec<String> = rest.iter().take(40).map(|n| n.to_string()).collect();
        out.push_str(&format!(
            "\nAussi {} : {}{}.\n",
            if index.is_pdf() {
                "aux pages"
            } else {
                "dans les sections"
            },
            listed.join(", "),
            if rest.len() > 40 { ", …" } else { "" },
        ));
    }
    out
}

pub fn get_pages(index: &BookIndex, from: usize, to: usize) -> Result<String, String> {
    let last = index
        .page_count
        .max(index.pages.last().map_or(0, |p| p.page));
    if from == 0 || to < from {
        return Err(format!(
            "Intervalle invalide : {from}–{to}. Les {} vont de 1 à {last}.",
            index.unit_plural()
        ));
    }
    if to - from + 1 > MAX_PAGES_PER_CALL {
        return Err(format!(
            "Au plus {MAX_PAGES_PER_CALL} {} par appel : demande {from}–{}.",
            index.unit_plural(),
            from + MAX_PAGES_PER_CALL - 1
        ));
    }
    if from > last {
        return Err(format!(
            "Le livre n'a que {last} {} : {from} n'existe pas.",
            index.unit_plural()
        ));
    }
    let mut out = index.numbering_note();
    if !out.is_empty() {
        out.push('\n');
    }
    let mut budget = MAX_CHARS_PER_CALL;
    for n in from..=to.min(last) {
        match index.pages.iter().find(|p| p.page == n) {
            Some(_) if budget == 0 => {
                out.push_str(&format!(
                    "[{n}] non renvoyée : limite de {MAX_CHARS_PER_CALL} caractères par appel atteinte ; redemande à partir de {n}.\n\n"
                ));
                break;
            }
            Some(page) => {
                let text = page.text.trim();
                let count = text.chars().count();
                if count <= budget {
                    budget -= count;
                    out.push_str(&format!("[{}]\n{}\n\n", index.cite(page), text));
                } else {
                    let cut: String = text.chars().take(budget).collect();
                    out.push_str(&format!(
                        "[{}]\n{}\n… (tronqué : {} caractères de plus dans cette {})\n\n",
                        index.cite(page),
                        cut,
                        count - budget,
                        if index.is_pdf() { "page" } else { "section" },
                    ));
                    budget = 0;
                }
            }
            None if !index.complete => out.push_str(&format!(
                "[{n}] pas encore indexée : l'index est en construction.\n\n"
            )),
            None => out.push_str(&format!("[{n}] (aucun texte sur cette page)\n\n")),
        }
    }
    Ok(out.trim_end().to_string())
}

pub fn get_toc(index: &BookIndex) -> String {
    if index.toc.is_empty() {
        return format!(
            "Ce livre n'a pas de table des matières ({} {}). Utilise search_book.",
            index.page_count.max(index.pages.len()),
            index.unit_plural()
        );
    }
    let mut out = String::new();
    for entry in &index.toc {
        let indent = "  ".repeat(entry.depth);
        match entry.page {
            Some(page) if index.is_pdf() => {
                out.push_str(&format!("{indent}{} — p. {page}\n", entry.label))
            }
            Some(page) => out.push_str(&format!("{indent}{} — section {page}\n", entry.label)),
            None => out.push_str(&format!("{indent}{}\n", entry.label)),
        }
    }
    out.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Protocol

fn tool_list() -> Value {
    json!({ "tools": [
        {
            "name": "search_book",
            "description": "Cherche un mot, une expression ou un symbole dans tout le livre (insensible à la casse et aux espaces ; ∫, ∑, ≠ sont aussi trouvés quand l'extraction du PDF les a abîmés). Renvoie les pages, celles qui semblent définir le terme en premier, avec un extrait autour de chaque occurrence.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Mot, expression ou symbole à chercher." },
                    "max_results": { "type": "integer", "description": "Nombre de pages détaillées (8 par défaut, 20 au plus).", "minimum": 1, "maximum": MAX_RESULTS }
                },
                "required": ["query"]
            }
        },
        {
            "name": "get_pages",
            "description": "Texte extrait des pages from à to du livre (5 au plus par appel), chaque page précédée de son numéro. Le texte d'un PDF perd les indices et la structure des formules.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "integer", "minimum": 1 },
                    "to": { "type": "integer", "minimum": 1 }
                },
                "required": ["from", "to"]
            }
        },
        {
            "name": "get_toc",
            "description": "Table des matières du livre, avec le numéro de page de chaque entrée.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ]})
}

/// The index file, read again whenever it changes on disk.
pub struct IndexSource {
    path: PathBuf,
    loaded: Option<(SystemTime, BookIndex)>,
}

impl IndexSource {
    pub fn new(path: PathBuf) -> IndexSource {
        IndexSource { path, loaded: None }
    }

    fn get(&mut self) -> Result<&BookIndex, String> {
        let modified = std::fs::metadata(&self.path)
            .and_then(|m| m.modified())
            .map_err(|_| {
                "L'index du livre n'est pas encore prêt : il se construit à l'ouverture du livre. Réessaie dans un instant, ou réponds sans chercher.".to_string()
            })?;
        let stale = self.loaded.as_ref().map_or(true, |(at, _)| *at != modified);
        if stale {
            let raw = std::fs::read_to_string(&self.path)
                .map_err(|e| format!("Index du livre illisible : {e}"))?;
            let mut index: BookIndex = serde_json::from_str(&raw)
                .map_err(|e| format!("Index du livre illisible : {e}"))?;
            index.detect_printed_offset();
            self.loaded = Some((modified, index));
        }
        Ok(&self.loaded.as_ref().expect("loaded above").1)
    }
}

fn arg_usize(args: &Value, key: &str) -> Option<usize> {
    let v = args.get(key)?;
    v.as_u64()
        .map(|n| n as usize)
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

pub fn call_tool(source: &mut IndexSource, name: &str, args: &Value) -> Result<String, String> {
    let index = source.get()?;
    match name {
        "search_book" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .ok_or("search_book attend un paramètre query.")?;
            let max = arg_usize(args, "max_results").unwrap_or(DEFAULT_RESULTS);
            Ok(search(index, query, max))
        }
        "get_pages" => {
            let from = arg_usize(args, "from").ok_or("get_pages attend from et to.")?;
            let to = arg_usize(args, "to").unwrap_or(from);
            get_pages(index, from, to)
        }
        "get_toc" => Ok(get_toc(index)),
        other => Err(format!("Outil inconnu : {other}")),
    }
}

/// Answer one JSON-RPC message; None for a notification.
pub fn handle(source: &mut IndexSource, message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => {
            let asked = message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION);
            json!({
                "protocolVersion": asked,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "reader", "version": env!("CARGO_PKG_VERSION") }
            })
        }
        "ping" => json!({}),
        "tools/list" => tool_list(),
        "tools/call" => {
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let empty = json!({});
            let args = message.pointer("/params/arguments").unwrap_or(&empty);
            match call_tool(source, name, args) {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                // A tool error is a result the model reads, not a protocol error.
                Err(text) => {
                    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
                }
            }
        }
        _ => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") }
            }))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Serve the tools on stdin/stdout until the CLI closes the pipe. Returns the
/// process exit code.
pub fn serve(index_path: Option<String>) -> i32 {
    let Some(path) = index_path else {
        eprintln!("usage: Marginalia --reader-tools <index.json>");
        return 2;
    };
    let mut source = IndexSource::new(Path::new(&path).to_path_buf());
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => handle(&mut source, &message),
            Err(e) => Some(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": format!("parse error: {e}") }
            })),
        };
        if let Some(reply) = reply {
            if writeln!(stdout, "{reply}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> BookIndex {
        BookIndex {
            title: "Test".into(),
            unit: "page".into(),
            complete: true,
            page_count: 4,
            toc: vec![
                TocEntry { label: "1 Linear Algebra".into(), page: Some(1), depth: 0 },
                TocEntry { label: "1.1 Tensors".into(), page: Some(2), depth: 1 },
            ],
            pages: vec![
                IndexedPage { page: 1, label: None, text: "We use a ⊗ b for the tensor product later.".into() },
                IndexedPage { page: 2, label: None, text: "Definition 1.2 (Tensor product). The tensor product a ⊗ b of two\nvectors is".into() },
                IndexedPage { page: 3, label: None, text: "E[x] = Z ∞\n−∞ xp(x)dx (6.83a) and (µ1, σ1)̸ = (µ2, σ2)".into() },
                IndexedPage { page: 4, label: None, text: "V[x] = \u{2}ασ12 + (1 − α)σ22\u{3} and the random variable Z is".into() },
            ],
            printed_offset: None,
        }
    }

    #[test]
    fn finds_a_symbol_and_puts_its_definition_first() {
        let out = search(&book(), "⊗", 8);
        assert!(out.contains("2 occurrences sur 2 pages"), "{out}");
        let first = out.find("[p. 2]").unwrap();
        let second = out.find("[p. 1]").unwrap();
        assert!(first < second, "{out}");
        assert!(out.contains("semble définir"), "{out}");
        assert!(out.contains("«⊗»"), "{out}");
    }

    #[test]
    fn ignores_case_spaces_and_line_breaks() {
        let out = search(&book(), "TENSOR PRODUCT a ⊗ b of two vectors", 8);
        assert!(out.contains("[p. 2]"), "{out}");
    }

    #[test]
    fn reads_extraction_artefacts_as_symbols() {
        assert!(search(&book(), "∫", 8).contains("[p. 3]"));
        assert!(search(&book(), "≠", 8).contains("[p. 3]"));
        assert!(search(&book(), "[ασ12", 8).contains("[p. 4]"));
        // A real variable Z is still found as a Z.
        assert!(search(&book(), "variable Z", 8).contains("[p. 4]"));
        // The set of integers is not an integral.
        let mut ints = book();
        ints.pages[3].text = "for all x ∈ Z | x > 0, and (Z, +) is a group".into();
        assert!(!search(&ints, "∫", 8).contains("[p. 4]"));
    }

    #[test]
    fn puts_sure_matches_before_guesses_and_labels_the_guesses() {
        let mut b = book();
        b.pages[0].text = "Notation: the random variable X takes values".into();
        b.pages[1].text = "the sum ∑ of all terms".into();
        let out = search(&b, "∑", 8);
        let sure = out.find("[p. 2]").unwrap();
        let guess = out.find("[p. 1]").unwrap();
        assert!(sure < guess, "{out}");
        assert!(out.contains("à vérifier"), "{out}");
        // A guess never claims to define the term.
        assert!(!out[guess..].contains("semble définir"), "{out}");
    }

    #[test]
    fn highlights_the_whole_repaired_sign() {
        let out = search(&book(), "≠", 8);
        assert!(out.contains("«̸ =»"), "{out}");
    }

    #[test]
    fn finds_the_gap_between_pdf_and_printed_numbers() {
        let mut b = book();
        b.pages = (1..=30)
            .map(|n| IndexedPage {
                page: n,
                label: None,
                text: if n > 6 {
                    format!("{} Linear Algebra\ntext of the page", n - 6)
                } else {
                    "Contents".into()
                },
            })
            .collect();
        b.page_count = 30;
        b.detect_printed_offset();
        assert_eq!(b.printed_offset, Some(6));
        let pages = get_pages(&b, 10, 10).unwrap();
        assert!(pages.contains("[p. 10 (imprimée 4)]"), "{pages}");
        assert!(pages.contains("ajoute 6"), "{pages}");
        // A book printing the PDF's own numbers has no note.
        let mut same = book();
        same.detect_printed_offset();
        assert_eq!(same.printed_offset, None);
    }

    #[test]
    fn caps_what_one_call_returns() {
        let mut epub = book();
        epub.unit = "section".into();
        epub.pages[0].text = "a".repeat(MAX_CHARS_PER_CALL + 500);
        let out = get_pages(&epub, 1, 3).unwrap();
        assert!(out.contains("tronqué : 500 caractères de plus"), "{out}");
        assert!(out.contains("redemande à partir de 2"), "{out}");
    }

    #[test]
    fn says_when_nothing_is_found() {
        assert!(search(&book(), "eigenvalue", 8).contains("Aucune occurrence"));
        assert!(search(&book(), "   ", 8).contains("Recherche vide"));
    }

    #[test]
    fn warns_while_the_index_is_being_built() {
        let mut partial = book();
        partial.complete = false;
        partial.page_count = 400;
        assert!(search(&partial, "⊗", 8).contains("encore en construction"));
    }

    #[test]
    fn lists_the_pages_beyond_the_detailed_ones() {
        let out = search(&book(), "the", 1);
        assert!(out.contains("Aussi aux pages"), "{out}");
    }

    #[test]
    fn returns_pages_with_their_numbers_and_refuses_bad_ranges() {
        let out = get_pages(&book(), 2, 3).unwrap();
        assert!(out.starts_with("[p. 2]\nDefinition 1.2"), "{out}");
        assert!(out.contains("[p. 3]"));
        assert!(get_pages(&book(), 1, 9).unwrap_err().contains("Au plus 5"));
        assert!(get_pages(&book(), 7, 8).unwrap_err().contains("n'a que 4"));
        assert!(get_pages(&book(), 3, 2).is_err());
        assert!(get_pages(&book(), 0, 1).is_err());
    }

    #[test]
    fn prints_the_toc_with_pages() {
        let toc = get_toc(&book());
        assert_eq!(toc, "1 Linear Algebra — p. 1\n  1.1 Tensors — p. 2");
        let mut no_toc = book();
        no_toc.toc.clear();
        assert!(get_toc(&no_toc).contains("pas de table des matières"));
    }

    #[test]
    fn cites_sections_for_a_reflowable_book() {
        let mut epub = book();
        epub.unit = "section".into();
        epub.pages[1].label = Some("Tensors".into());
        assert!(search(&epub, "⊗", 8).contains("[section 2 « Tensors »]"));
    }

    #[test]
    fn speaks_the_protocol() {
        let dir = std::env::temp_dir().join(format!("reader-tools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.json");
        let mut source = IndexSource::new(path.clone());

        let init = handle(
            &mut source,
            &json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}),
        )
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
        assert!(handle(
            &mut source,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .is_none());
        let list = handle(
            &mut source,
            &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        )
        .unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 3);

        // No index yet: a readable tool error, not a crash.
        let call = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_toc","arguments":{}}});
        let early = handle(&mut source, &call).unwrap();
        assert_eq!(early["result"]["isError"], true);
        assert!(early["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("pas encore prêt"));

        // The index lands: the next call reads it.
        std::fs::write(&path, r#"{"unit":"page","complete":true,"pageCount":1,"toc":[{"label":"Intro","page":1,"depth":0}],"pages":[{"page":1,"text":"Hello"}]}"#).unwrap();
        let later = handle(&mut source, &call).unwrap();
        assert_eq!(later["result"]["content"][0]["text"], "Intro — p. 1");

        let unknown = handle(
            &mut source,
            &json!({"jsonrpc":"2.0","id":3,"method":"resources/list"}),
        )
        .unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
        std::fs::remove_dir_all(&dir).ok();
    }
}
