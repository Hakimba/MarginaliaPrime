# MarginaliaPrime

Compagnon de lecture pour livres techniques : lecteur EPUB/PDF (Readest, via foliate-js + pdf.js)
avec un panneau de chat Claude qui sait toujours ce que le lecteur regarde. Fork de
[eddmann/Marginalia](https://github.com/eddmann/Marginalia), licence AGPL-3.0.

Stack : Tauri v2 (Rust) + Next.js 16 + React 19 + TypeScript, pnpm workspaces. Source de l'app dans `app/`.

## Documents de pilotage (à lire avant toute tâche)

Dossier `docs/harness/` : local uniquement, exclu du dépôt via `.git/info/exclude`, jamais poussé.

- `docs/harness/CAHIER_DES_CHARGES.md` : spécification, exigences F*, tests d'acceptation T1–T10.
- `docs/harness/TASKS.md` : plan de tâches T0–T5, défauts D1–D14, périmètre POC. Une tâche = une branche = une PR.
- `docs/harness/REVUE_TASKS.md` : revue de faisabilité indépendante, bloquants B1–B5 à respecter.
- `docs/harness/GUIDE_TEST_MARGINALIA.md` : essai rapide de l'app d'origine.

## Contraintes non négociables

- Aucune clé API. Le modèle est appelé uniquement via le CLI `claude` (abonnement) lancé en
  sous-processus par le backend Tauri. Jamais de lecture de jeton OAuth, jamais d'appel API direct.
- Pas de `--bare` sur le CLI : il désactive l'abonnement.
- Outils intégrés du CLI désactivés (`--tools ""`), seuls les outils MCP `reader` sont exposés (B4).
- Le serveur MCP doit être lancé avec un Node ≥ 20 par chemin absolu : `/usr/bin/node` est en v12 (B2).
- Tout reste local : livres, index, glossaire, conversations.

## Commandes

```
make help        # liste des cibles
make install     # pnpm install --frozen-lockfile + copie des vendors pdf.js
make dev         # pnpm tauri dev (première compilation Rust : 10–20 min)
make lint        # eslint + cargo fmt --check + clippy
make build       # binaire de production
```

Prérequis machine : Rust stable (rustup), pnpm 10.29.2 via corepack, Node ≥ 20 (fnm), paquets
Debian `libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev build-essential libssl-dev`.

## Repères dans le code

- Chat : `app/src/app/reader/components/chat/` (`ChatPanel.tsx`, `ModelSelector.tsx`, `InspectOverlay.tsx`).
- Moteur IA actuel (Pi, à remplacer en T1) : `app/src/services/pi/agent.ts`, `app/src/store/apiKeyStore.ts`.
- Contexte de lecture : `app/src/services/chapterExtraction.ts`, `app/src/app/reader/components/FoliateViewer.tsx`,
  sélection et texte autour dans `app/src/app/reader/components/annotator/Annotator.tsx`.
- Raccourcis clavier : `app/src/helpers/shortcuts.ts` (`ctrl+shift+c` envoie déjà la sélection au chat).
- Moteur de lecture : `packages/foliate-js/` ; PDF dans `packages/foliate-js/pdf.js` (une section par page).
- Backend Rust : `app/src-tauri/src/lib.rs`, dépendances dans `app/src-tauri/Cargo.toml`.

## Conventions de travail

- Branches : `feat/<nom-de-la-tache>` depuis `main`, une PR par tâche, fusion séquentielle. Jamais de
  commit direct sur `main` après T0.
- Chaque PR cite la tâche de `TASKS.md` et coche les tests d'acceptation concernés.
- Commits en anglais, impératif, préfixe `feat:`, `fix:`, `chore:`, `docs:`.
- `make lint` doit passer avant toute PR.
- Remote `upstream` = eddmann/Marginalia, pour récupérer ses correctifs par rebase ou merge.
- Interface utilisateur et docs de pilotage en français ; code, commentaires et commits en anglais.
