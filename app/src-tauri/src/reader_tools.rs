//! The reader's tools, served to the `claude` CLI over MCP (JSON-RPC on stdio).
//!
//! The CLI launches this very binary with `--reader-tools <index.json>` (see
//! `main.rs`): no Node, no second program to install, and the path is always
//! right since the app writes it from its own location. The process has no
//! window and never touches Tauri; it reads the book index the app wrote and
//! answers book search, page retrieval, table of contents and glossary tools.
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

/// Where the reader is, written by the app next to the index at every page
/// turn and every change of permission, and read again at every call: the
/// CLI's process outlives any environment given to it at launch.
#[derive(Deserialize, Default, Clone, Debug)]
pub struct ReadingState {
    /// The furthest page read. None: nothing known, nothing hidden.
    #[serde(default, rename = "maxPage")]
    pub max_page: Option<usize>,
    #[serde(default, rename = "currentPage")]
    pub current_page: Option<usize>,
    /// The reader lets the model read ahead (a book read before).
    #[serde(default, rename = "spoilersAllowed")]
    pub spoilers_allowed: bool,
    /// Pages the reader opened for this turn only, beyond the furthest read.
    #[serde(default, rename = "allowedWindow")]
    pub allowed_window: Option<[usize; 2]>,
}

/// Pages past the furthest read the model may see: the app sends them with
/// the reading context already (a proof that runs over, the facing page).
const AHEAD: usize = 2;

impl ReadingState {
    /// The furthest page read, when known: 0 means nothing was recorded.
    fn max(&self) -> Option<usize> {
        self.max_page.filter(|&m| m > 0)
    }

    /// Whether the model may be shown this page.
    pub fn visible(&self, page: usize) -> bool {
        self.spoilers_allowed
            || self
                .max()
                .map_or(true, |max| page <= max.saturating_add(AHEAD))
            || self
                .allowed_window
                .is_some_and(|[from, to]| page >= from && page <= to)
    }

    fn unread_note(&self, index: &BookIndex) -> String {
        match self.max() {
            Some(max) if index.is_pdf() => format!("au-delà de la p. {max}"),
            Some(max) => format!("au-delà de la section {max}"),
            None => String::new(),
        }
    }
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

/// The section around `page`, from the table of contents: [start, end).
fn section_around(index: &BookIndex, page: usize) -> (usize, usize) {
    let starts: Vec<usize> = index.toc.iter().filter_map(|e| e.page).collect();
    let start = starts
        .iter()
        .copied()
        .filter(|&p| p <= page)
        .max()
        .unwrap_or(1);
    let end = starts
        .iter()
        .copied()
        .filter(|&p| p > start)
        .min()
        .unwrap_or(usize::MAX);
    (start, end)
}

pub fn search(index: &BookIndex, query: &str, max_results: usize, state: &ReadingState) -> String {
    let needle_plain = Compact::of(query, false).chars;
    let needle_repaired = Compact::of(query, true).chars;
    if needle_plain.is_empty() {
        return "Recherche vide : donne un mot, une expression ou un symbole.".to_string();
    }
    let pages: Vec<PageHits> = index
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

    // What the reader has not reached is counted, never shown.
    let (mut pages, mut hidden): (Vec<PageHits>, Vec<PageHits>) = pages
        .into_iter()
        .partition(|p| state.visible(index.pages[p.index].page));
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
    hidden.sort_by_key(|p| (!p.exact, !p.definition, p.index));
    let unread = unread_summary(index, state, &hidden);
    if pages.is_empty() {
        if hidden.is_empty() {
            out.push_str(&format!("Aucune occurrence de « {query} » dans le livre."));
        } else {
            out.push_str(&format!(
                "Aucune occurrence de « {query} » dans ce que le lecteur a lu.\n"
            ));
            out.push_str(&unread);
        }
        return out;
    }
    // Sure matches first. Near the reader first (the same symbol may mean
    // another thing elsewhere), definitions first among equals, then the
    // closest pages; without a position, book order.
    match state.current_page {
        Some(current) => {
            let (start, end) = section_around(index, current);
            pages.sort_by_key(|p| {
                let page = index.pages[p.index].page;
                let near = (page >= start && page < end) || page.abs_diff(current) <= 3;
                (!p.exact, !near, !p.definition, page.abs_diff(current))
            });
        }
        None => pages.sort_by_key(|p| (!p.exact, !p.definition, p.index)),
    }
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
    if !unread.is_empty() {
        out.push('\n');
        out.push_str(&unread);
    }
    out
}

/// What lies beyond the furthest page read, without a word of its content,
/// and the pages the reader may open with one click (`[non-lu: …]`, read by
/// the app to offer them).
fn unread_summary(index: &BookIndex, state: &ReadingState, hidden: &[PageHits]) -> String {
    if hidden.is_empty() {
        return String::new();
    }
    let count: usize = hidden.iter().map(|p| p.hits.len()).sum();
    let mut pages: Vec<usize> = hidden.iter().map(|p| index.pages[p.index].page).collect();
    let offered: Vec<String> = pages.iter().take(3).map(|n| n.to_string()).collect();
    pages.sort();
    let listed: Vec<String> = pages.iter().take(12).map(|n| n.to_string()).collect();
    format!(
        "Plus loin, dans une partie que le lecteur n'a pas encore lue ({}) : {count} occurrence{} ({} {}{}). Leur contenu n'est pas montré. Ne le devine pas et ne le raconte pas, même si tu connais le livre : dis au lecteur que c'est traité plus loin, à quelle page, et propose-lui de regarder ; il peut t'ouvrir une page d'un clic.\n[non-lu: {}]\n",
        state.unread_note(index),
        if count > 1 { "s" } else { "" },
        if index.is_pdf() { "p." } else { "sections" },
        listed.join(", "),
        if pages.len() > 12 { ", …" } else { "" },
        offered.join(", "),
    )
}

pub fn get_pages(
    index: &BookIndex,
    from: usize,
    to: usize,
    state: &ReadingState,
) -> Result<String, String> {
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
    if (from..=to.min(last)).all(|n| !state.visible(n)) {
        return Err(format!(
            "{} non lue{} : le lecteur n'est pas encore allé {}. N'en devine pas le contenu ; propose-lui de regarder : il peut t'ouvrir une page d'un clic.\n[non-lu: {}]",
            if from == to.min(last) { format!("p. {from}") } else { format!("p. {from}–{}", to.min(last)) },
            if from == to.min(last) { "" } else { "s" },
            state.unread_note(index),
            from,
        ));
    }
    let mut out = index.numbering_note();
    if !out.is_empty() {
        out.push('\n');
    }
    let mut budget = MAX_CHARS_PER_CALL;
    let mut first_hidden = None;
    for n in from..=to.min(last) {
        if !state.visible(n) {
            first_hidden.get_or_insert(n);
            out.push_str(&format!(
                "[{n}] non lue : le lecteur n'est pas encore allé {} ; page non montrée.\n\n",
                state.unread_note(index)
            ));
            continue;
        }
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
    if let Some(n) = first_hidden {
        out.push_str(&format!("[non-lu: {n}]\n"));
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
            "description": "Cherche un mot, une expression ou un symbole dans tout le livre (insensible à la casse et aux espaces ; ∫, ∑, ≠ sont aussi trouvés quand l'extraction du PDF les a abîmés). Renvoie les pages, les plus proches du lecteur et celles qui semblent définir le terme en premier, avec un extrait autour de chaque occurrence. Ce que le lecteur n'a pas encore lu est seulement compté, pas montré.",
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
            "description": "Texte extrait des pages from à to du livre (5 au plus par appel), chaque page précédée de son numéro. Le texte d'un PDF perd les indices et la structure des formules. Les pages que le lecteur n'a pas encore lues sont refusées, sauf s'il les a ouvertes.",
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
        },
        {
            "name": "get_glossary",
            "description": "Consulte les explications déjà mémorisées pour ce livre, y compris dans les conversations précédentes. query retrouve exactement un terme ou symbole (sensible à la casse) ; sans query, renvoie les entrées autorisées par l'anti-spoiler.",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string", "maxLength": 200 } }
            }
        },
        {
            "name": "add_to_glossary",
            "description": "Mémorise un terme ou symbole expliqué au lecteur avec sa page PDF ou section EPUB de référence. Une sélection ou une page fournie par le lecteur peut servir de référence même au-delà de sa progression, sans autoriser la lecture de contenu masqué. Renvoie uniquement l'entrée enregistrée. Le même terme à la même page est mis à jour ; à une autre page, il conserve un sens distinct.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "term": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "latex": { "type": "string", "maxLength": 2000 },
                    "explanation": { "type": "string", "minLength": 1, "maxLength": 8000 },
                    "page": { "type": "integer", "minimum": 1, "maximum": 1000000 }
                },
                "required": ["term", "explanation", "page"]
            }
        }
    ]})
}

/// The index file, read again whenever it changes on disk, and the reading
/// state beside it (`<hash>.state.json`), read at every call.
pub struct IndexSource {
    path: PathBuf,
    loaded: Option<(SystemTime, BookIndex)>,
}

impl IndexSource {
    pub fn new(path: PathBuf) -> IndexSource {
        IndexSource { path, loaded: None }
    }

    pub fn state_path(&self) -> PathBuf {
        let stem = self
            .path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        self.path.with_file_name(format!("{stem}.state.json"))
    }

    /// No state (a book not opened since the feature): nothing is hidden.
    fn state(&self) -> ReadingState {
        std::fs::read_to_string(self.state_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn glossary_state(&self) -> Result<ReadingState, String> {
        match std::fs::read_to_string(self.state_path()) {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|e| format!("Permissions de lecture illisibles ; glossaire refusé : {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ReadingState::default()),
            Err(e) => Err(format!(
                "Permissions de lecture inaccessibles ; glossaire refusé : {e}"
            )),
        }
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

/// Models write a page as `"2"` or `2.0`, and an absent formula as `null`:
/// read them as the integer and the empty string they mean, instead of losing
/// the entry for a formatting quirk. Anything else is left to the parser.
fn normalize_entry_args(args: &Value) -> Value {
    let mut args = args.clone();
    if let Some(obj) = args.as_object_mut() {
        if let Some(page) = obj.get("page") {
            let whole = match page {
                Value::String(s) => s.trim().parse::<u64>().ok(),
                Value::Number(n) => n
                    .as_f64()
                    .filter(|f| f.fract() == 0.0 && *f >= 0.0)
                    .map(|f| f as u64),
                _ => None,
            };
            if let Some(whole) = whole {
                obj.insert("page".into(), json!(whole));
            }
        }
        if obj.get("latex").is_some_and(Value::is_null) {
            obj.insert("latex".into(), json!(""));
        }
    }
    args
}

/// The visible entries, as JSON, within the size one call may return; the
/// entries left out are named so the model can ask for them one by one.
fn glossary_reply(entries: Vec<crate::glossary::Entry>) -> Result<String, String> {
    let mut shown = Vec::new();
    let mut size = 2;
    let mut omitted = Vec::new();
    for entry in entries {
        let one =
            serde_json::to_string(&entry).map_err(|e| format!("Glossaire illisible : {e}"))?;
        if omitted.is_empty() && size + one.len() < MAX_CHARS_PER_CALL {
            size += one.len() + 1;
            shown.push(entry);
        } else {
            omitted.push(entry.term);
        }
    }
    let mut out =
        serde_json::to_string(&shown).map_err(|e| format!("Glossaire illisible : {e}"))?;
    if !omitted.is_empty() {
        let mut names = String::new();
        for term in &omitted {
            if names.len() + term.len() > 4_000 {
                names.push_str(", …");
                break;
            }
            if !names.is_empty() {
                names.push_str(", ");
            }
            names.push_str(term);
        }
        out.push_str(&format!(
            "\n{} autres entrées non affichées (limite de taille) ; demande-les une à une avec query : {names}",
            omitted.len()
        ));
    }
    Ok(out)
}

pub fn call_tool(source: &mut IndexSource, name: &str, args: &Value) -> Result<String, String> {
    if matches!(name, "get_glossary" | "add_to_glossary") {
        if !args.is_object() {
            return Err("Les paramètres du glossaire doivent être un objet JSON.".into());
        }
        if name == "add_to_glossary" {
            let input: crate::glossary::EntryInput =
                serde_json::from_value(normalize_entry_args(args)).map_err(|e| {
                    format!(
                        "Entrée du glossaire invalide : term et explanation sont du texte, page un entier de 1 à 1 000 000, latex du texte facultatif ({e})."
                    )
                })?;
            let term = input.term.trim().to_string();
            let page = input.page;
            let saved: Vec<_> = crate::glossary::add(&source.path, input)?
                .into_iter()
                .filter(|entry| entry.term == term && entry.page == page)
                .collect();
            return serde_json::to_string(&saved).map_err(|e| format!("Glossaire illisible : {e}"));
        }
        let state = source.glossary_state()?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct QueryInput {
            query: Option<String>,
        }
        let input: QueryInput = serde_json::from_value(args.clone())
            .map_err(|e| format!("Recherche du glossaire invalide : {e}"))?;
        if input
            .query
            .as_ref()
            .is_some_and(|query| query.chars().count() > 200)
        {
            return Err("La recherche du glossaire est limitée à 200 caractères.".into());
        }
        // An empty query names no term: the whole visible glossary.
        let query = input
            .query
            .map(|query| query.trim().to_string())
            .filter(|query| !query.is_empty());
        let entries = crate::glossary::load(&source.path)?;
        let visible: Vec<_> = entries
            .into_iter()
            .filter(|entry| {
                state.visible(entry.page)
                    && query
                        .as_ref()
                        .map_or(true, |query| entry.term.trim() == query)
            })
            .collect();
        return glossary_reply(visible);
    }
    let state = source.state();
    let index = source.get()?;
    match name {
        "search_book" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .ok_or("search_book attend un paramètre query.")?;
            let max = arg_usize(args, "max_results").unwrap_or(DEFAULT_RESULTS);
            Ok(search(index, query, max, &state))
        }
        "get_pages" => {
            let from = arg_usize(args, "from").ok_or("get_pages attend from et to.")?;
            let to = arg_usize(args, "to").unwrap_or(from);
            get_pages(index, from, to, &state)
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

    /// No reading state: nothing hidden.
    fn open() -> ReadingState {
        ReadingState::default()
    }

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
        let out = search(&book(), "⊗", 8, &open());
        assert!(out.contains("2 occurrences sur 2 pages"), "{out}");
        let first = out.find("[p. 2]").unwrap();
        let second = out.find("[p. 1]").unwrap();
        assert!(first < second, "{out}");
        assert!(out.contains("semble définir"), "{out}");
        assert!(out.contains("«⊗»"), "{out}");
    }

    #[test]
    fn ignores_case_spaces_and_line_breaks() {
        let out = search(&book(), "TENSOR PRODUCT a ⊗ b of two vectors", 8, &open());
        assert!(out.contains("[p. 2]"), "{out}");
    }

    #[test]
    fn reads_extraction_artefacts_as_symbols() {
        assert!(search(&book(), "∫", 8, &open()).contains("[p. 3]"));
        assert!(search(&book(), "≠", 8, &open()).contains("[p. 3]"));
        assert!(search(&book(), "[ασ12", 8, &open()).contains("[p. 4]"));
        // A real variable Z is still found as a Z.
        assert!(search(&book(), "variable Z", 8, &open()).contains("[p. 4]"));
        // The set of integers is not an integral.
        let mut ints = book();
        ints.pages[3].text = "for all x ∈ Z | x > 0, and (Z, +) is a group".into();
        assert!(!search(&ints, "∫", 8, &open()).contains("[p. 4]"));
    }

    #[test]
    fn puts_sure_matches_before_guesses_and_labels_the_guesses() {
        let mut b = book();
        b.pages[0].text = "Notation: the random variable X takes values".into();
        b.pages[1].text = "the sum ∑ of all terms".into();
        let out = search(&b, "∑", 8, &open());
        let sure = out.find("[p. 2]").unwrap();
        let guess = out.find("[p. 1]").unwrap();
        assert!(sure < guess, "{out}");
        assert!(out.contains("à vérifier"), "{out}");
        // A guess never claims to define the term.
        assert!(!out[guess..].contains("semble définir"), "{out}");
    }

    #[test]
    fn highlights_the_whole_repaired_sign() {
        let out = search(&book(), "≠", 8, &open());
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
        let pages = get_pages(&b, 10, 10, &open()).unwrap();
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
        let out = get_pages(&epub, 1, 3, &open()).unwrap();
        assert!(out.contains("tronqué : 500 caractères de plus"), "{out}");
        assert!(out.contains("redemande à partir de 2"), "{out}");
    }

    /// A book of 10 pages: ⊗ defined as a group law p. 2, reused p. 8 as the
    /// outer product; chapters at 1 and 7.
    fn two_meanings() -> BookIndex {
        let mut b = book();
        b.page_count = 10;
        b.toc = vec![
            TocEntry {
                label: "1 Groups".into(),
                page: Some(1),
                depth: 0,
            },
            TocEntry {
                label: "2 Tensors".into(),
                page: Some(7),
                depth: 0,
            },
        ];
        b.pages = (1..=10)
            .map(|n| IndexedPage {
                page: n,
                label: None,
                text: match n {
                    2 => "Definition (Group). An operation ⊗ on G.".into(),
                    8 => "The outer product δ ⊗ δ of two vectors.".into(),
                    9 => "Definition (law of total variance). V[x] = E[V[x|y]]".into(),
                    _ => format!("page {n}"),
                },
            })
            .collect();
        b
    }

    fn at(current: usize, max: usize) -> ReadingState {
        ReadingState {
            max_page: Some(max),
            current_page: Some(current),
            ..Default::default()
        }
    }

    #[test]
    fn hides_what_the_reader_has_not_read_and_offers_it() {
        let out = search(&two_meanings(), "law of total variance", 8, &at(3, 4));
        assert!(
            out.contains(
                "Aucune occurrence de « law of total variance » dans ce que le lecteur a lu"
            ),
            "{out}"
        );
        assert!(out.contains("au-delà de la p. 4"), "{out}");
        assert!(out.contains("[non-lu: 9]"), "{out}");
        // Not a word of the hidden page.
        assert!(!out.contains("E[V"), "{out}");
    }

    #[test]
    fn shows_the_read_part_and_counts_the_rest() {
        let out = search(&two_meanings(), "⊗", 8, &at(3, 4));
        assert!(out.contains("[p. 2]"), "{out}");
        assert!(!out.contains("outer product"), "{out}");
        assert!(out.contains("[non-lu: 8]"), "{out}");
    }

    #[test]
    fn opens_ahead_with_the_switch_or_for_the_offered_pages() {
        let mut allowed = at(3, 4);
        allowed.spoilers_allowed = true;
        assert!(search(&two_meanings(), "law of total variance", 8, &allowed).contains("[p. 9]"));
        let mut window = at(3, 4);
        window.allowed_window = Some([9, 10]);
        assert!(get_pages(&two_meanings(), 9, 10, &window)
            .unwrap()
            .contains("total variance"));
        assert!(get_pages(&two_meanings(), 8, 8, &window).is_err());
    }

    #[test]
    fn refuses_unread_pages_and_marks_them_in_a_mixed_range() {
        let err = get_pages(&two_meanings(), 8, 9, &at(3, 4)).unwrap_err();
        assert!(err.contains("non lues"), "{err}");
        assert!(err.contains("[non-lu: 8]"), "{err}");
        // Two pages ahead are shown, as the app sends them anyway.
        let mixed = get_pages(&two_meanings(), 6, 7, &at(3, 4)).unwrap();
        assert!(mixed.contains("[p. 6]\npage 6"), "{mixed}");
        assert!(mixed.contains("[7] non lue"), "{mixed}");
        assert!(mixed.contains("[non-lu: 7]"), "{mixed}");
        // Nothing recorded yet: nothing hidden.
        assert!(get_pages(&two_meanings(), 9, 9, &at(3, 0)).is_ok());
    }

    #[test]
    fn ranks_the_meaning_near_the_reader_first() {
        let near_outer = search(&two_meanings(), "⊗", 8, &at(8, 9));
        assert!(
            near_outer.find("[p. 8]").unwrap() < near_outer.find("[p. 2]").unwrap(),
            "{near_outer}"
        );
        let near_group = search(&two_meanings(), "⊗", 8, &at(2, 9));
        assert!(
            near_group.find("[p. 2]").unwrap() < near_group.find("[p. 8]").unwrap(),
            "{near_group}"
        );
    }

    #[test]
    fn reads_the_state_file_next_to_the_index() {
        let source = IndexSource::new(PathBuf::from("/data/index/abc.json"));
        assert_eq!(
            source.state_path(),
            PathBuf::from("/data/index/abc.state.json")
        );
        let state: ReadingState = serde_json::from_str(
            r#"{"maxPage":35,"currentPage":20,"spoilersAllowed":false,"allowedWindow":[209,210],"updatedAt":1}"#,
        )
        .unwrap();
        assert!(state.visible(37) && !state.visible(38) && state.visible(210));
    }

    #[test]
    fn says_when_nothing_is_found() {
        assert!(search(&book(), "eigenvalue", 8, &open()).contains("Aucune occurrence"));
        assert!(search(&book(), "   ", 8, &open()).contains("Recherche vide"));
    }

    #[test]
    fn warns_while_the_index_is_being_built() {
        let mut partial = book();
        partial.complete = false;
        partial.page_count = 400;
        assert!(search(&partial, "⊗", 8, &open()).contains("encore en construction"));
    }

    #[test]
    fn lists_the_pages_beyond_the_detailed_ones() {
        let out = search(&book(), "the", 1, &open());
        assert!(out.contains("Aussi aux pages"), "{out}");
    }

    #[test]
    fn returns_pages_with_their_numbers_and_refuses_bad_ranges() {
        let out = get_pages(&book(), 2, 3, &open()).unwrap();
        assert!(out.starts_with("[p. 2]\nDefinition 1.2"), "{out}");
        assert!(out.contains("[p. 3]"));
        assert!(get_pages(&book(), 1, 9, &open())
            .unwrap_err()
            .contains("Au plus 5"));
        assert!(get_pages(&book(), 7, 8, &open())
            .unwrap_err()
            .contains("n'a que 4"));
        assert!(get_pages(&book(), 3, 2, &open()).is_err());
        assert!(get_pages(&book(), 0, 1, &open()).is_err());
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
        assert!(search(&epub, "⊗", 8, &open()).contains("[section 2 « Tensors »]"));
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
        let names: Vec<_> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "search_book",
                "get_pages",
                "get_toc",
                "get_glossary",
                "add_to_glossary"
            ]
        );

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

    #[test]
    fn glossary_saves_a_selected_definition_without_granting_read_access() {
        let dir = std::env::temp_dir().join(format!(
            "reader-glossary-selected-definition-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.json");
        let mut source = IndexSource::new(path.clone());
        for (term, page) in [("CDF", 187), ("future", 188), ("later", 200)] {
            call_tool(
                &mut source,
                "add_to_glossary",
                &json!({"term":term,"explanation":"previous hidden explanation","page":page}),
            )
            .unwrap();
        }
        std::fs::write(source.state_path(), r#"{"maxPage":176}"#).unwrap();
        let input = json!({"term":" CDF ","explanation":"Explanation given for the selected passage","page":187});
        let saved: Vec<crate::glossary::Entry> =
            serde_json::from_str(&call_tool(&mut source, "add_to_glossary", &input).unwrap())
                .unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].term, "CDF");
        assert_eq!(saved[0].page, 187);
        assert_eq!(saved[0].explanation, input["explanation"]);
        assert_eq!(crate::glossary::load(&path).unwrap().len(), 3);
        for query in [json!({}), json!({"query":"CDF"}), json!({"query":"future"})] {
            assert_eq!(
                call_tool(&mut source, "get_glossary", &query).unwrap(),
                "[]"
            );
        }
        std::fs::write(
            source.state_path(),
            r#"{"maxPage":176,"allowedWindow":[187,188]}"#,
        )
        .unwrap();
        let visible: Vec<crate::glossary::Entry> =
            serde_json::from_str(&call_tool(&mut source, "get_glossary", &json!({})).unwrap())
                .unwrap();
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[0], saved[0]);
        assert_eq!(visible[1].term, "future");
        std::fs::write(source.state_path(), r#"{"maxPage":176}"#).unwrap();
        assert_eq!(
            call_tool(&mut source, "get_glossary", &json!({})).unwrap(),
            "[]"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn glossary_works_without_index_and_rereads_permissions_every_call() {
        let dir = std::env::temp_dir().join(format!(
            "reader-glossary-permissions-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.json");
        let mut source = IndexSource::new(path.clone());
        assert_eq!(
            call_tool(&mut source, "get_glossary", &json!({})).unwrap(),
            "[]"
        );
        for (term, page) in [("X", 2), ("x", 2), ("future", 20)] {
            call_tool(
                &mut source,
                "add_to_glossary",
                &json!({"term":term,"explanation":"Définition","page":page}),
            )
            .unwrap();
        }
        let exact: Value = serde_json::from_str(
            &call_tool(&mut source, "get_glossary", &json!({"query":" X "})).unwrap(),
        )
        .unwrap();
        assert_eq!(exact.as_array().unwrap().len(), 1);
        assert_eq!(exact[0]["term"], "X");

        std::fs::write(source.state_path(), r#"{"maxPage":2}"#).unwrap();
        assert!(!call_tool(&mut source, "get_glossary", &json!({}))
            .unwrap()
            .contains("future"));
        call_tool(
            &mut source,
            "add_to_glossary",
            &json!({"term":"hidden","explanation":"secret","page":20}),
        )
        .unwrap();
        assert_eq!(
            call_tool(&mut source, "get_glossary", &json!({"query":"future"})).unwrap(),
            "[]"
        );

        std::fs::write(
            source.state_path(),
            r#"{"maxPage":2,"allowedWindow":[20,21]}"#,
        )
        .unwrap();
        assert!(call_tool(&mut source, "get_glossary", &json!({}))
            .unwrap()
            .contains("future"));
        call_tool(
            &mut source,
            "add_to_glossary",
            &json!({"term":"window","explanation":"window definition","page":20}),
        )
        .unwrap();
        std::fs::write(source.state_path(), r#"{"maxPage":2}"#).unwrap();
        let added = call_tool(
            &mut source,
            "add_to_glossary",
            &json!({"term":"now","explanation":"current definition","page":2}),
        )
        .unwrap();
        assert!(!added.contains("future") && !added.contains("window"));
        let added_entries: Vec<crate::glossary::Entry> = serde_json::from_str(&added).unwrap();
        assert_eq!(added_entries.len(), 1);
        assert_eq!(added_entries[0].term, "now");
        std::fs::write(
            source.state_path(),
            r#"{"maxPage":2,"spoilersAllowed":true}"#,
        )
        .unwrap();
        assert!(call_tool(&mut source, "get_glossary", &json!({}))
            .unwrap()
            .contains("window"));

        std::fs::write(&path, r#"{"pageCount":10,"complete":false}"#).unwrap();
        assert!(call_tool(
            &mut source,
            "add_to_glossary",
            &json!({"term":"outside","explanation":"outside book","page":11})
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn glossary_reads_fail_closed_for_corrupt_permissions_and_writes_preserve_corrupt_storage() {
        let dir =
            std::env::temp_dir().join(format!("reader-glossary-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.json");
        let mut source = IndexSource::new(path.clone());
        let input = json!({"term":"x","explanation":"definition","page":2});
        call_tool(&mut source, "add_to_glossary", &input).unwrap();
        for corrupt in ["{broken", r#"{"spoilersAllowed":"true"}"#, "null"] {
            std::fs::write(source.state_path(), corrupt).unwrap();
            assert!(call_tool(&mut source, "get_glossary", &json!({})).is_err());
            let saved: Vec<crate::glossary::Entry> =
                serde_json::from_str(&call_tool(&mut source, "add_to_glossary", &input).unwrap())
                    .unwrap();
            assert_eq!(saved.len(), 1);
            assert_eq!(saved[0].term, "x");
            assert_eq!(saved[0].explanation, "definition");
            assert_eq!(saved[0].page, 2);
            assert_eq!(crate::glossary::load(&path).unwrap(), saved);
            assert!(call_tool(&mut source, "get_glossary", &json!({})).is_err());
        }
        std::fs::remove_file(source.state_path()).unwrap();
        std::fs::write(crate::glossary::glossary_path(&path), b"broken glossary").unwrap();
        let call = json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_to_glossary","arguments":input}});
        assert_eq!(
            handle(&mut source, &call).unwrap()["result"]["isError"],
            true
        );
        assert_eq!(
            std::fs::read(crate::glossary::glossary_path(&path)).unwrap(),
            b"broken glossary"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn glossary_accepts_the_number_formats_models_write_and_an_empty_query() {
        let dir =
            std::env::temp_dir().join(format!("reader-glossary-formats-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.json");
        let mut source = IndexSource::new(path.clone());
        for args in [
            json!({"term":"a","explanation":"d","page":"2"}),
            json!({"term":"b","explanation":"d","page":3.0}),
            json!({"term":"c","latex":null,"explanation":"d","page":4}),
        ] {
            call_tool(&mut source, "add_to_glossary", &args).expect("accepted");
        }
        let pages: Vec<usize> = crate::glossary::load(&path)
            .unwrap()
            .iter()
            .map(|e| e.page)
            .collect();
        assert_eq!(pages, vec![2, 3, 4]);
        let all: Vec<crate::glossary::Entry> = serde_json::from_str(
            &call_tool(&mut source, "get_glossary", &json!({"query":""})).unwrap(),
        )
        .unwrap();
        assert_eq!(all.len(), 3);
        let err = call_tool(
            &mut source,
            "add_to_glossary",
            &json!({"term":"x","explanation":"d","page":"deux"}),
        )
        .unwrap_err();
        assert!(err.contains("page un entier"), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn glossary_reply_stays_within_one_call_and_names_the_rest() {
        let entries: Vec<crate::glossary::Entry> = (0..300)
            .map(|n| crate::glossary::Entry {
                term: format!("t{n}"),
                latex: String::new(),
                explanation: "x".repeat(500),
                page: 1,
                date: 0,
            })
            .collect();
        let out = glossary_reply(entries).unwrap();
        assert!(out.len() < MAX_CHARS_PER_CALL + 5_000, "{}", out.len());
        let (json_part, note) = out.split_once('\n').unwrap();
        let shown: Vec<crate::glossary::Entry> = serde_json::from_str(json_part).unwrap();
        assert!(!shown.is_empty() && shown.len() < 300);
        assert!(
            note.contains(&format!("{} autres entrées", 300 - shown.len())),
            "{note}"
        );
        assert!(note.contains("t299"), "{note}");
    }

    #[test]
    fn glossary_tools_reject_non_objects_unknown_fields_and_wrong_types() {
        let dir =
            std::env::temp_dir().join(format!("reader-glossary-arguments-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.json");
        let mut source = IndexSource::new(path.clone());
        for args in [
            Value::Null,
            json!([]),
            json!(["x"]),
            json!({"unknown":"x"}),
            json!({"query":12}),
            json!({"query":"x".repeat(201)}),
        ] {
            assert!(
                call_tool(&mut source, "get_glossary", &args).is_err(),
                "accepted {args}"
            );
        }
        for args in [
            Value::Null,
            json!([]),
            json!(["x", "", "definition", 1]),
            json!({"term":"x","explanation":"definition","page":1,"date":0}),
            json!({"term":"x","explanation":"definition","page":1.5}),
        ] {
            assert!(
                call_tool(&mut source, "add_to_glossary", &args).is_err(),
                "accepted {args}"
            );
        }
        assert!(crate::glossary::load(&path).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
