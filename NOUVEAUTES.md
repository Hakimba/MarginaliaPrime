# MarginaliaPrime — ce qui change par rapport à Marginalia

Fork de [eddmann/Marginalia](https://github.com/eddmann/Marginalia), lui-même fork de
[Readest](https://github.com/readest/readest). Objectif : lire des livres techniques avec Claude à
côté, sur son propre abonnement, sans copier-coller.

Ce document liste ce que le fork ajoute ou change, mis à jour à chaque PR fusionnée.

## Pour démarrer

```bash
# Prérequis : Claude Code installé et connecté (`claude` doit répondre dans un terminal)
make install
cd app && pnpm tauri build --no-bundle
./src-tauri/target/release/Marginalia
```

Aucune clé API à fournir. Le chat utilise la connexion Claude Code déjà présente sur la machine, donc
il consomme le quota de l'abonnement. Si le binaire `claude` n'est pas dans le `PATH`, le chemin peut
être forcé avec la variable d'environnement `MARGINALIA_CLAUDE_BIN`.

---

## Le chat parle à Claude via l'abonnement

*(PR #8)*

- **Plus de clé API, plus de jeton lu en cachette.** Marginalia lisait le jeton OAuth de Claude Code
  dans le trousseau macOS et appelait l'API directement, ce qui ne marchait pas sur Linux. Le fork
  lance le CLI `claude` officiel en processus enfant ; c'est lui qui s'authentifie.
- **Un processus par conversation, gardé vivant.** Le CLI garde l'historique et le cache de prompt
  reste chaud : les questions suivantes coûtent moins et répondent plus vite.
- **La conversation survit à la fermeture.** Rouvrir un livre le lendemain reprend la discussion là
  où elle s'était arrêtée, avec la mémoire réelle du modèle, pas seulement l'affichage.
- **Une conversation par livre**, sans mélange : changer de livre change de conversation et de
  session.
- **Modèles à jour**, choisis en deux niveaux (moteur puis modèle) : Opus 5, Sonnet 5, Haiku 4.5.
- **Contexte de lecture envoyé automatiquement** : la position dans le livre, le passage sélectionné
  et le texte autour. Pour un PDF, une fenêtre de pages autour du lecteur plutôt que le chapitre
  entier, qui pouvait représenter une partie complète du livre.
- **Consignes de lecture** données au modèle : répondre en français, transcrire fidèlement les
  mathématiques en LaTeX avant d'expliquer, donner le caractère Unicode exact d'un symbole, ne pas
  inventer quand le passage est illisible.
- **Texte des chapitres mieux extrait** : les formules sont encadrées en LaTeX, les appels de notes
  deviennent `[12]` au lieu d'être collés au mot précédent.
- **Panneau « contexte envoyé »** (icône chevron) : la ligne de commande exacte, les consignes, le
  message tel qu'il part, la consommation de tokens et le flux brut du moteur. Rien n'est caché.
- **Erreurs lisibles** : CLI absent, abonnement déconnecté, limite d'usage atteinte, refus du modèle.
  Le lecteur reste utilisable même si le moteur ne démarre pas.
- **Reprise robuste** : si la session enregistrée a disparu, une session neuve est lancée et la
  question rejouée automatiquement.

## Plus rapide, et débarrassé de ce qui ne sert pas

*(PR #7)*

- **Un clic sur un livre ne crée plus une seconde fenêtre** qui rejouait tout le démarrage de
  l'application.
- **Démarrage environ trois fois plus rapide** : feuille de style passée de 1,3 Mo à 0,2 Mo,
  JavaScript de 10 Mo à 5 Mo, deux extensions inutiles retirées.
- **Plus de blocage à l'ouverture d'un PDF.** L'extraction du texte pour le chat prenait cinq
  secondes sur le fil principal, juste au moment où l'on tourne les premières pages. Elle est
  maintenant différée et plafonnée.
- **La page précédente est préchargée** en plus de la suivante.
- **Synchronisation cloud et comptes retirés** : l'outil est local et mono-utilisateur. Les boutons
  « Upload to Cloud », la barre de synchronisation et les réglages de compte ont disparu ; la
  suppression d'un livre reste locale et supprime aussi sa vignette.
- **Environ 1 400 lignes de code hérité supprimées** : copie inutilisée de pdf.js, modules sans
  usage, fenêtre de sauvegarde morte, configurations d'outils absents.
- **Outils de mesure** : `scripts/perf-run.sh` chronomètre le démarrage et l'ouverture d'un livre,
  `scripts/smoke-chat.sh` rejoue des scénarios de chat complets sans intervention.

---

## Ce qui n'est pas encore fait

- Les formules dans les réponses s'affichent en LaTeX brut, sans rendu mathématique.
- Sur un PDF, seule la couche texte est envoyée au modèle ; l'image du passage sélectionné suivra,
  ce qui compte pour les formules, les matrices et les symboles mal extraits.
- La sélection à la souris dans un PDF est imprécise et ramasse les notes de marge.
- Le modèle ne peut pas encore chercher ailleurs dans le livre, ni se souvenir d'un terme déjà
  expliqué d'une conversation à l'autre.

## Licence

AGPL-3.0, comme Readest et Marginalia. Un fork distribué doit rester sous la même licence.
