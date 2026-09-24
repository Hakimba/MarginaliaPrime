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

## Les formules s'affichent comme dans le livre

*(PR #13)*

- **Les mathématiques des réponses sont rendues** (KaTeX) au lieu d'apparaître en LaTeX brut :
  fractions, sommes, intégrales, matrices, accolades légendées, couleurs, arbres de dérivation.
- **Tous les délimiteurs sont reconnus** : `$…$` et `$$…$$`, mais aussi `\(…\)` et `\[…\]`, que
  Claude emploie souvent. La typographie française ne les casse pas : « (où $x$) », « l'$x$ »,
  « $x$ ; » sont rendus. Un prix (« 5$ et 10$ ») et le contenu des blocs de code restent du texte.
- **Une formule trop large défile dans sa bulle** au lieu d'élargir la réponse au-delà du panneau.
- **Une formule mal écrite ne casse rien** : sa source s'affiche en rouge, le reste de la réponse
  est rendu normalement.
- **Lisible en thème sombre** : les formules prennent la couleur du texte, et les couleurs que le
  modèle peut employer ont été choisies pour les deux thèmes.
- **Réponses rendues au fil de l'eau** sans ralentir : chaque formule n'est composée qu'une fois,
  et le panneau ne recalcule plus toute la conversation à chaque morceau reçu. Le texte d'une
  réponse se sélectionne et se copie normalement.
- **Le modèle explique une formule en l'annotant** : chaque terme coloré et légendé sous une
  accolade (ou numéroté ①, ②…), puis une légende dans les mêmes couleurs, plutôt qu'une liste de
  morceaux recopiés. Les règles d'inférence et les arbres de dérivation sont écrits en fractions
  imbriquées, avec le nom de chaque règle en marge. Les constructions que KaTeX ne sait pas rendre
  (`bussproofs`, `tikz`) lui sont interdites. Ces consignes valent pour les nouvelles
  conversations.
- **Ctrl+E explique la sélection tout de suite** : la question « Explique ce passage. » part avec
  le passage sélectionné, panneau fermé ou ouvert. Si une réponse est encore en cours, la question
  attend dans le champ de saisie avec sa sélection. `Ctrl+Shift+C` joint toujours la sélection
  sans rien envoyer.
- **Une réponse ne peut plus être perdue** en ouvrant une nouvelle conversation (ou en changeant
  de conversation) juste après son arrivée : l'enregistrement, différé d'une demi-seconde, était
  annulé au lieu d'être fait.

## Choisir une formule d'un clic

*(PR #13)*

- **Les formules d'une page PDF sont repérées toutes seules** : fractions, intégrales, matrices,
  systèmes, équations alignées, avec leur numéro « (6.100) ». Sur le livre de maths utilisé pour tester,
  96 % des équations numérotées sont trouvées. Le repérage se fait une fois la page affichée, au repos :
  la lecture n'en est pas ralentie.
- **Au survol d'une formule**, un contour pointillé et une pastille « + » dans la marge. Un clic sur la
  pastille la choisit (①), un autre sur une deuxième formule l'ajoute (②), même si elles ne sont pas
  alignées. Plus besoin de viser les morceaux d'une formule à la souris.
- **La sélection de texte ne change pas** : glisser sur la page sélectionne du texte, un clic tourne la
  page, formule ou pas. Seule la pastille, dans la marge, choisit.
- **Une barre en bas de la page** : Ask AI (ou Ctrl+E) pour demander tout de suite, Joindre pour
  accumuler des formules de plusieurs pages dans la même question, ✕ (ou Échap) pour tout retirer.
- **Le modèle reçoit l'image de chaque formule**, nette, recadrée depuis le PDF, avec le texte extrait
  en secours : une intégrale que le texte du PDF donnait « Z ∞ » est lue correctement. Les vignettes
  s'affichent dans la puce en attente et dans le message, et restent après redémarrage.
- **Bouton Σ** dans l'en-tête : affiche toutes les formules de la page d'un coup. **Bouton Zone** :
  trace un rectangle à la main pour ce qui n'a pas été repéré (un graphique, par exemple).

## Une page à la fois, et la page ne se perd plus

*(PR #12)*

- **Un PDF s'ouvre sur une seule page**, lisible, au lieu de deux pages minuscules côte à côte.
  Idem pour les bandes dessinées (CBZ) et les EPUB à mise en page fixe. Un choix fait
  explicitement pour un livre reste respecté.
- **Le menu Vue propose « Une page » et « Deux pages (auto) »**, avec l'option active visible. En
  mode deux pages, une fenêtre étroite (par exemple avec le chat ouvert) repasse à une page.
- **Le choix est retenu pour chaque livre**, dès qu'on le fait, et survit au redémarrage.
- **Passer d'une à deux pages garde la page lue**, qu'elle soit paire ou impaire, y compris en
  basculant vite ou en revenant du défilement continu : plus de saut ailleurs ni de page blanche.
- **Pointeur normal aussi dans les EPUB**, sans empêcher la sélection ni changer le curseur des
  liens.

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

- Sur un PDF, seule la couche texte est envoyée au modèle ; l'image du passage sélectionné suivra,
  ce qui compte pour les formules, les matrices et les symboles mal extraits.
- On ne peut pas encore mettre deux passages en relation dans la même question.
- Le modèle ne peut pas encore chercher ailleurs dans le livre, ni se souvenir d'un terme déjà
  expliqué d'une conversation à l'autre.

## Licence

AGPL-3.0, comme Readest et Marginalia. Un fork distribué doit rester sous la même licence.
