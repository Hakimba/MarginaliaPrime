# Brief — MarginaliaPrime côté liseuse et serveur

Document de référence pour la personne ou l'agent qui implémentera cette évolution.
Tout ce dont il a besoin est ici ; le reste du dépôt donne le code.

Règle de départ, non négociable : **MarginaliaPrime se décline, il n'est pas remplacé.**
L'application de bureau garde exactement son comportement actuel. On en extrait un noyau
partagé, on ajoute un serveur, et on ajoute un client léger. Aucune fonction du bureau ne doit
disparaître, changer de place ou changer d'apparence.

---

## 1. Le besoin

Le lecteur possède un homelab qui héberge déjà sa bibliothèque de livres (une pile *arr qui
télécharge et range, et un accès depuis la liseuse). Il veut lire sur une liseuse, sélectionner
un passage, appuyer sur « Ask » et recevoir la réponse de Marginalia — les mêmes réponses
qu'aujourd'hui, adaptées à l'écran e-ink.

Les livres et le serveur vivant au même endroit, le serveur peut connaître le livre sans qu'on
le lui envoie : ni upload, ni identification approximative du fichier.

Contraintes du lecteur :

- **Pas d'abonnement Claude sur le serveur.** Il aura un abonnement donnant accès à un modèle
  (probablement compatible OpenAI, éventuellement chinois). Le moteur doit donc être
  interchangeable, et Claude n'est qu'un cas particulier.
- Il n'a pas encore de liseuse : il testera d'abord sur un PC Linux (KOReader s'y installe à
  l'identique) avant d'acheter. Matériel visé : 10" type Boox (Android, KOReader en APK).
- Son iPhone ne peut pas faire tourner KOReader : ce n'est pas une cible.

---

## 2. Décisions déjà prises

| Sujet | Décision | Pourquoi |
|---|---|---|
| Forme du produit | L'app de bureau reste ; on extrait un noyau, un serveur, un client | Demandé ; évite de casser ce qui a des utilisateurs |
| Client liseuse | **KOReader + un fork léger du greffon `assistant.koplugin`** | Seul lecteur qui donne sélection, rendu et réseau sans réécrire une liseuse |
| Client de repli | APK Marginalia (Tauri v2 mobile) sur une liseuse Android | Si l'ergonomie e-ink du greffon déçoit ; lourd, mais zéro Lua |
| Serveur | Service HTTP au homelab, même noyau que le bureau | Le livre et le serveur au même endroit |
| API | Route compatible OpenAI **et** route maison | La standard permet de tester avec le greffon stock ; la maison transporte livre, page, sélections |
| Index | Construit **à l'arrivée du livre**, par une veille de la bibliothèque | Supprime l'attente à la première ouverture |
| Contexte d'un PDF | Le serveur joint **l'image de la page** | Le texte extrait d'un PDF abîme les symboles (∫ → « Z ») |
| Maths sur liseuse | Unicode par défaut ; **image rendue par le serveur** pour les cas difficiles | KaTeX ne tourne pas sur l'appareil ; une image à 300 dpi est plus lisible qu'un texte pauvre |
| Explication d'une formule | Termes **numérotés ①②③** au lieu de colorés | L'e-ink est en noir et blanc ; le code couleur devient illisible |
| Formules sur la page | **Menu Σ** (liste des formules de la page, avec vignettes) | Pas de survol sur une liseuse ; dessiner un contour exige une conversion géométrique fragile |
| Frontend maison | Non | Reviendrait à réécrire la liseuse |

Décisions encore ouvertes, à trancher avant de coder le moteur :

1. **Forme de l'abonnement** : clé + adresse HTTP (le serveur appelle directement), ou
   programme en ligne de commande à lancer (comme `claude` aujourd'hui) ? Les deux sont
   supportés par la conception, mais le premier travail dépend de la réponse.
2. **Format des fichiers par livre** : on impose le format du bureau (voir §5), sauf raison.
3. **Sécurité** : jeton unique d'appairage suffit-il, ou faut-il autre chose (le serveur n'est
   pas exposé sur Internet) ?

---

## 3. État de l'art, en résumé

Sept options examinées : KOReader + greffon, Marginalia/Readest en APK Android, application web
dans le navigateur de la liseuse, Plato, Librera, reMarkable + toltec, PocketBook + KOReader.

- **KOReader** gagne : greffons en Lua, sélection exploitable, rendu EPUB/PDF, tourne sur Kindle
  (jailbreak), Kobo, PocketBook, reMarkable, Android. Son greffon `assistant.koplugin` fait déjà
  le geste attendu : sélection → Ask → réponse en flux, Markdown, notes, et accepte **n'importe
  quelle adresse compatible OpenAI** via `base_url`. Il possède aussi une boucle d'appels d'outils
  (recherche web) et un harnais de tests headless.
- **Rejetés** : Plato n'a aucune API de greffon ; Librera est forkable mais sans écosystème et
  avec un PDF plus faible ; le navigateur de la liseuse n'accède pas au fichier du livre et ne
  donne aucune sélection exploitable.
- **Repli sérieux** : Readest (dont Marginalia descend) tourne sur Android ; Marginalia pourrait
  donc être compilé en APK pour une liseuse Android, le moteur restant sur le serveur.

Références : <https://koreader.rocks/doc/> ,
<https://github.com/omer-faruq/assistant.koplugin> (variantes : `zivshek`, `boypt`, `zeeyado`),
<https://github.com/koreader/koreader>.

---

## 4. Architecture

Quatre zones : la liseuse, le homelab, le modèle, la bibliothèque.

```
   LISEUSE                          HOMELAB                            MODÈLE
┌──────────────────┐        ┌──────────────────────────────┐      ┌──────────────┐
│ KOReader         │        │  API  /v1/…  /marginalia/…    │      │ moteur       │
│  lecture, rendu  │──livre+page──▶                            │      │ (HTTP ou CLI)│
│                  │        │        │                     │      │              │
│ greffon          │◀──texte+images──  noyau partagé     │◀────▶│              │
│  Ask · Joindre   │        │   harnais · plan du tour     │      └──────────────┘
│  Σ · Glossaire   │        │        │                     │
│                  │        │  index du livre ◀── veille ◀─┼──── bibliothèque *arr
│ position lecture │──▶     │  état de lecture · glossaire │
└──────────────────┘        └──────────────────────────────┘
```

Schéma mis en forme : `docs/liseuse/architecture.html` (et `architecture.png`).

**Déroulé d'une question, de bout en bout :**

1. Le lecteur sélectionne un passage ; le greffon connaît le fichier du livre, la page affichée,
   la page la plus loin lue, et le texte sélectionné.
2. Il poste sur la route maison : livre, position, sélection (une ou plusieurs), question.
3. Le serveur retrouve le livre par son identifiant, son index déjà construit, et l'état de
   lecture.
4. Il construit le message : position, chapitre ou pages autour non encore envoyées, sélections
   numérotées, image de la page pour un PDF, noms des termes du glossaire autorisés.
5. Il applique le harnais « liseuse » (variante : réponses courtes, termes numérotés).
6. Il interroge le moteur configuré ; celui-ci peut demander des outils (chercher dans le livre,
   lire des pages, consulter ou écrire le glossaire) — filtrés par l'anti-spoiler.
7. La réponse revient en flux ; le serveur y ajoute ce que l'appareil ne sait pas produire :
   images de formules, liste des pages citées.
8. Le greffon affiche ; un appui sur « p. 42 » saute à la page ; les entrées de glossaire sont
   écrites côté serveur.

---

## 5. Vocabulaire et données

**Index du livre** — fichier JSON par livre, à côté des données du serveur. Le texte de chaque
page (ou section) et la table des matières avec les numéros de page. Rien d'autre. C'est ce qui
permet de chercher dans 600 pages en quelques dizaines de millisecondes, de citer « p. 42 » et
de filtrer par l'anti-spoiler sans rouvrir le PDF.

Format (identique à celui du bureau, voir `app/src/services/bookIndex.ts`) :

```json
{ "version": 1, "hash": "...", "title": "...", "unit": "page", "complete": true,
  "pageCount": 417,
  "toc":    [ { "label": "6.5 Gaussian Distribution", "page": 202, "depth": 1 } ],
  "pages":  [ { "page": 42, "label": null, "text": "…" } ],
  "notation": "…", "notationPage": 12 }
```

`unit` vaut `page` pour un PDF (mise en page fixe) et `section` pour un EPUB.

**Harnais** — le brief permanent donné au modèle une fois par conversation : qui il est, ce qu'il
reçoit, comment répondre (français, concis, transcription des maths d'abord), les règles
d'anti-spoiler, les interdits (environnements LaTeX non rendus). Il ne contient **jamais** ce qui
varie d'un tour à l'autre (position, sélection) : le modèle fige ce brief au premier message.
Source actuelle : `app/src/services/engine/harness.ts`, fonction `buildHarness`.

**Plan du tour** — la décision de ce qui part à chaque message : le chapitre une seule fois,
chaque page une seule fois, la notation au premier message. Source : `planContext`, même fichier.

**Anti-spoiler** — l'app retient la page la plus loin lue. Règle exacte
(`app/src/utils/readingProgress.ts`) : elle n'avance que si le lecteur lit à la suite depuis
cette limite (un ou deux pages) ; un saut, un retour en arrière ou une réouverture ailleurs ne la
font pas bouger. Un clic sur « lu jusqu'à p. N » la corrige à la main. Le serveur accepte deux
pages de marge (`AHEAD = 2`) et une fenêtre de pages ouvertes pour un tour
(`allowedWindow`), toutes deux décrites dans `app/src-tauri/src/reader_tools.rs`.

**Glossaire** — par livre : terme, LaTeX facultatif, explication, page de référence, date. Même
terme à la même page = mise à jour ; à une autre page = entrée distincte. Le lecteur voit tout ;
le modèle ne voit que ce que l'anti-spoiler autorise.

**Puces** — les passages joints à une question, numérotés ①②, chacun avec sa page et son image
éventuelle. « Joindre » les accumule, « Ask » envoie.

**Données par livre, côté serveur** (mêmes formats que le bureau) :

```
<data>/<hash>/index.json      texte des pages + table des matières
<data>/<hash>/state.json      maxPage, currentPage, spoilersAllowed, allowedWindow
<data>/<hash>/glossary.json   entrées du glossaire
<data>/<hash>/chats/<conv>.jsonl   conversations
libres/<hash>.<ext>           le fichier du livre (ou un lien vers la bibliothèque)
```

---

## 6. Travail attendu

Le détail en cartes est dans `docs/liseuse/KANBAN.md` ; voici la logique d'ensemble.

1. **Fondations sans effet visible** — extraire harnais + plan du tour + lecture du flux dans un
   paquet partagé consommé par le bureau ; les tests du bureau restent verts ; abstraction du
   moteur (adaptateur « CLI », adaptateur « HTTP compatible OpenAI ») ; variante de harnais
   « liseuse ».
2. **Serveur qui parle** — service HTTP (liste des modèles, conversation en flux, erreurs
   lisibles), cycle de vie du moteur, jeton. Sortie : une réponse s'affiche sur la liseuse depuis
   le greffon **non modifié**, grâce à la route standard.
3. **Serveur qui connaît le livre** — veille de la bibliothèque, extracteur PDF puis EPUB,
   recherche/pages/table des matières (réutiliser `reader_tools.rs`), routage des outils selon le
   moteur, image de page, anti-spoiler, glossaire, conversations reprises.
4. **Greffon** — préréglage fournisseur « Marginalia », envoi livre + page, bouton Joindre, menu
   Σ, onglet Glossaire, liens « p. N », affichage des images, tests headless.
5. **Format et exploitation** — règles de réponse liseuse, maths Unicode puis image, essai à
   l'œil, conteneur, journal, documentation.

### Contrat d'API proposé

| Route | Rôle |
|---|---|
| `POST /v1/chat/completions` | Format OpenAI, flux SSE. Sert à tester avec le greffon stock. Sans livre connu : répond avec ce que le client envoie. |
| `GET /v1/models` | Liste des modèles proposés par le serveur. |
| `POST /marginalia/ask` | Route maison : `{ book, position, selections[], question, conversationId, mode:"eink" }`. Flux SSE de texte + événements (`attachments`, `pages_cited`, `glossary`). |
| `POST /marginalia/reading` | Le client pousse `{ bookId, page, total, percent, furthestRead }`. |
| `GET /marginalia/books` | Livres connus, avec état d'indexation. |
| `GET /marginalia/glossary?book=` | Entrées du glossaire. |
| `GET /healthz` | Vivant, version, moteur configuré. |

Authentification : un jeton d'appairage en en-tête, configurable par variable d'environnement.
Erreurs : lisibles par un humain, jamais de trace technique seule.

### Ce que le serveur doit produire pour l'e-ink

- Réponses courtes, sans tableau large ni bloc de code multi-colonnes.
- Maths : Unicode pour les formules simples (`∫₀¹ x² dx`), image rendue pour les cas difficiles
  (fractions, matrices, accolades).
- Formule expliquée : terme marqués ①②③ et légende reprenant les mêmes numéros, au lieu des
  couleurs utilisées sur le bureau.
- Les images sont produites par le serveur (KaTeX → SVG → PNG, ou rendu LaTeX), à une résolution
  adaptée à l'écran, et de taille raisonnable (viser < 100 Ko par image).

---

## 7. Ce qui existe déjà et qu'il faut réutiliser

| Besoin | Où c'est déjà écrit |
|---|---|
| Lancement du moteur, flux ligne par ligne, cycle de vie | `app/src-tauri/src/engine.rs` |
| Outils du livre sans fenêtre (recherche, pages, table des matières, glossaire) | `app/src-tauri/src/reader_tools.rs`, point d'entrée `--reader-tools` dans `main.rs` |
| Stockage index et état de lecture, écriture atomique | `app/src-tauri/src/book_index.rs` |
| Glossaire, fusion, écriture atomique | `app/src-tauri/src/glossary.rs` |
| Harnais, plan du tour, format des messages | `app/src/services/engine/harness.ts` |
| Arguments du moteur, événements du flux | `app/src/services/engine/claudeCliEngine.ts`, `parseCliEvent.ts` |
| Règle de progression « lu jusqu'à » | `app/src/utils/readingProgress.ts` |
| Construction de l'index (à porter côté serveur) | `app/src/services/bookIndex.ts`, `chapterExtraction.ts` |
| Persistance des conversations | `app/src/services/chat/persistence.ts` |
| Bouchon de test compatible OpenAI (déjà écrit et vérifié) | `scripts/mock-openai-server.py` |

**Le point le plus lourd** est le portage de la construction de l'index hors du navigateur : sur
le bureau elle utilise le rendu et les parsers de la fenêtre (`foliate-js`, pdf.js). Côté serveur,
utiliser `pdfjs-dist` en Node pour le PDF, et une extraction XHTML + table des matières pour
l'EPUB. Le format de sortie doit rester celui du §5 à l'octet près.

---

## 8. Contraintes de non-régression et conventions

- L'application de bureau ne change pas de comportement. Les tests existants doivent passer sans
  modification : `cd app && npx vitest run` (aujourd'hui 263 tests verts, 5 ignorés) et
  `npx tsgo --noEmit`.
- Le code partagé est **extrait**, pas dupliqué : une seule copie du harnais, une seule du plan
  du tour.
- Interface et commentaires en **français** ; sujets de commit en anglais, conventionnels
  (`feat:`, `fix:`, `perf:`), une branche `feat/<sujet>` et une PR par sujet.
- Documentation vivante : `NOUVEAUTES.md` reçoit une section par PR fusionnée (langage simple,
  comportement visible, pas de jargon) ; `FONCTIONNEMENT.md` décrit le comportement situation par
  situation et doit être mis à jour à chaque fonction ajoutée.
- Le lecteur valide à l'œil : chaque livraison doit être jugeable sans lire le code.

---

## 9. Risques à mesurer avant d'investir

1. **Un modèle non-Claude sait-il appeler les outils ?** Si le modèle choisi n'appelle pas
   correctement les fonctions (chercher dans le livre, lire des pages), il faut que le serveur
   décide lui-même de chercher et impose les extraits. Cette bascule change plusieurs cartes :
   à mesurer sur un vrai livre **avant** d'écrire le reste.
2. **Transcription des maths.** C'est la fonction la plus appréciée ; un modèle plus faible
   recopie moins fidèlement. À mesurer en même temps, sur le même livre.
3. **Fidélité du texte extrait** : parade déjà prévue (image de page).
4. **Latence** : 20 à 40 s par réponse ; le flux est indispensable.

---

## 10. Ce qu'on ne fait pas

- Aucune refonte de l'application de bureau, aucune fonction retirée.
- Pas d'application web de Marginalia dans un navigateur.
- Pas de contour cliquable dessiné par-dessus la page sur la liseuse.
- Pas de KaTeX côté client.
- Pas de client maison avant d'avoir essayé le greffon greffé au vrai serveur.
