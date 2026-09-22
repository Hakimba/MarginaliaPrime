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

## Sélectionner ce qu'on veut dans un PDF

*(PR #11)*

- **La sélection à la souris ne part plus en vrille.** Dans un PDF, chaque mot est un petit bloc posé
  à une position absolue, et le navigateur choisit ce qu'il sélectionne sans regarder ce qui est
  autour : relâcher la souris six pixels au-dessus d'une ligne posait le curseur dans l'en-tête de
  page, vingt lignes plus haut, et tout le paragraphe partait dans la sélection. La sélection est
  maintenant pilotée par la géométrie de la page : la ligne la plus proche, puis le mot, puis le
  caractère.
- **On sélectionne exactement ce qu'on glisse**, une moitié de mot comprise. Pour un mot entier ou une
  ligne entière, il y a les gestes qu'il faut : **double-clic** et **triple-clic**.
- **Un glisser commencé au milieu d'une ligne commence là**, et non au début de la ligne : une ligne de
  PDF porte souvent un espace unique large de toute la ligne (mesuré : 262 points sur une page), et
  c'est lui qui happait le début de la sélection.
- **Les notes de marge ne sont plus ramassées** : la colonne de marge est reconnue et mise à part, et
  un glisser reste dans la colonne où il a commencé.
- **Les étiquettes de graphique non plus** : les chiffres d'axes, les légendes et les labels de courbes
  sont reconnus (bien plus petits que le texte courant, éparpillés, parfois tournés) et sortis du
  chemin. Sélectionner un paragraphe posé au-dessus d'une figure ne ramène plus « 10 −4 −2 0 2 4 ».
  La légende de la figure, elle, reste du texte à lire.
- **Une main qui tremble reste sur sa ligne** : tant que le pointeur ne s'éloigne pas d'une demi-ligne,
  c'est la ligne où le glisser a commencé qui compte.
- **Le texte d'une sélection n'est plus collé** : « dimensionsdo not match » redevient
  « dimensions do not match », et un mot coupé en fin de ligne est recollé (« cho- sen » → « chosen »).
- **Le texte envoyé au modèle est en ordre de lecture** : sur le livre de maths utilisé pour tester,
  4 391 inversions d'ordre sur l'ensemble du livre sont tombées à zéro, et les mots collés sont passés
  de 1 651 à 97. Les notes de marge et les étiquettes de figures sont regroupées et annoncées comme
  telles (`[note de marge]`, `[figure]`) : le modèle ne lit plus un chiffre d'axe au milieu d'une
  phrase.
- **Le contexte autour d'une sélection dans un PDF** est désormais de trois lignes de chaque côté, au
  lieu de trois mots.
- **Le panneau de chat rétrécit le lecteur** au lieu de le recouvrir ; la page se remet en page à côté.
- **La souris sur le contenu est repartie de zéro.** Un glisser sélectionne, sans rien poser devant le
  texte. Un clic sur le passage fait apparaître **une seule bulle, « Ask AI »** — plus la barre héritée
  de Readest avec ses six boutons qui surgissait d'elle-même à chaque sélection. Un clic ailleurs
  enlève tout, immédiatement (elle mettait jusqu'à une seconde, ou restait). Surligner, annoter et
  copier restent sur leurs raccourcis clavier.
- **Plus de curseur en forme de main** qui apparaissait et disparaissait au fil de la page : un
  pointeur normal partout.
- **Le panneau de chat ne peut plus manger la fenêtre** : une largeur retenue d'une grande fenêtre
  laissait le lecteur à six pixels et les pages étaient rendues à 1 % de leur taille.
- **La sélection en attente est consultable en entier** dans le chat (elle s'ouvre d'un clic, avec son
  nombre de caractères) : ce qui part au modèle est vérifiable avant d'envoyer.
- **Une page PDF ne reste plus blanche indéfiniment.** Un défaut du moteur d'affichage de WebKit
  laissait le rendu d'une page en attente pour toujours, sans aucune erreur ; c'est probablement ce
  qui obligeait à cliquer deux fois sur un livre. Contourné au démarrage.
- **Un clic sur un livre suffit** : l'appui garde le pointeur, donc le retour visuel qui rétrécit la
  vignette ne peut plus annuler le clic.
- **Ouverture d'un livre plus rapide** : le texte des pages envoyé au chat est construit directement
  depuis le PDF, sans passer par la couche de rendu de pdf.js — 13 pages en 0,4 s au lieu de 5 s.
- **Les échecs d'extraction ne sont plus silencieux** : un chapitre vide était impossible à distinguer
  d'une erreur du modèle.

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
- On ne peut pas encore mettre deux passages en relation dans la même question.
- Le modèle ne peut pas encore chercher ailleurs dans le livre, ni se souvenir d'un terme déjà
  expliqué d'une conversation à l'autre.

## Licence

AGPL-3.0, comme Readest et Marginalia. Un fork distribué doit rester sous la même licence.
