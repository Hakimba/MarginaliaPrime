# MarginaliaPrime — comment ça marche

Ce document décrit le comportement de l'application, situation par situation : « tu fais ceci, il se
passe cela ». Il sert de référence pour écrire les tutoriels d'utilisation, et il est mis à jour à
chaque fonctionnalité ajoutée. Ce qui est nouveau est listé dans `NOUVEAUTES.md` ; ici, on décrit
ce qui est, pas ce qui a changé.

---

## 1. Le chat

- **Tu ouvres le panneau de chat** (bouton du chat, ou en envoyant un passage) : il s'ancre à droite
  et le livre se remet en page à côté, sans être recouvert. Tu peux l'élargir en tirant son bord
  gauche ; il ne prend jamais plus de 60 % de la fenêtre.
- **Tu poses une question** : elle part à Claude par le programme `claude` de ton abonnement (aucune
  clé API). La réponse arrive au fil de l'eau.
- **Chaque livre a ses conversations.** Changer de livre change de conversation. La dernière
  conversation d'un livre se rouvre avec lui, le lendemain comme dans une minute, et Claude s'en
  souvient vraiment.
- **« + » en haut du chat** : nouvelle conversation (l'ancienne reste dans la liste déroulante).
  **Corbeille** : supprime la conversation affichée.
- **Le choix du modèle** (en haut à gauche) vaut pour les questions suivantes ; la conversation
  continue avec le nouveau modèle.
- **Le globe** à gauche de la saisie autorise Claude à chercher sur le web (désactivé par défaut).
- **`</>` (voir le contexte envoyé)** : ce qui partira exactement avec la prochaine question (texte,
  images, pages jointes), la ligne de commande, la consommation de la dernière réponse.

## 2. Lire un PDF

- **Un PDF s'ouvre sur une seule page.** Menu Vue → « Deux pages (auto) » pour deux pages côte à côte
  (repasse à une page si la fenêtre est trop étroite). Le choix est retenu pour chaque livre, et
  changer de mode garde la page lue.
- **Clic simple sur la page** : la page tourne (moitié gauche : en arrière, droite : en avant).
- **Glisser** : sélectionne exactement ce que tu glisses, sans déborder sur les notes de marge ni sur
  les chiffres des graphiques. **Double-clic** : un mot. **Triple-clic** : une ligne.
- **Clic sur le passage sélectionné** : une bulle « Ask AI » apparaît. Clic ailleurs : tout disparaît.

## 3. Montrer un passage à Claude

### Du texte

- **« Ask AI » sur une sélection** (ou **Ctrl+Shift+C**) : le passage est joint au chat, sans rien
  envoyer. Il apparaît en bas du panneau comme une **puce** : page, section, nombre de mots, et une
  vignette (voir ci-dessous).
- **Ctrl+E** sur une sélection : le passage est joint et la question « Explique ce passage. » part
  tout de suite. Si une réponse est en cours, la question attend dans la saisie.
- **Dans un PDF, le passage part avec son image**, cadrée sur les lignes sélectionnées. Claude lit
  l'image comme la vérité : le texte extrait d'un PDF perd souvent les indices et les symboles
  (∫ devient « Z »). **Dans un EPUB**, pas d'image : le texte suffit.

### Une formule, d'un clic

- **Survole une formule affichée** d'un PDF : un contour pointillé et une pastille « + » dans la marge
  gauche. **Clic sur la pastille** : la formule est choisie (①). D'autres clics en ajoutent (②, ③).
- **Une barre apparaît en bas** : **Ask AI** (ou Ctrl+E) envoie tout de suite, **Joindre** met les
  formules en puces pour les combiner avec d'autres, **✕** (ou Échap) retire le choix.
- **Bouton Σ** (en-tête) : montre toutes les formules repérées de la page. **Bouton Zone** : trace un
  rectangle à la main, pour ce qui n'a pas été repéré (un graphique).
- **Tourner la page** abandonne les formules choisies et pas encore jointes.

### Plusieurs passages

- **Chaque passage joint s'ajoute** : ①, ②, ③… dans l'ordre. Tu peux les relier dans la question
  (« compare 1 et 2 »), même s'ils sont à 200 pages d'écart.
- **Le même passage deux fois** ne fait qu'une puce.
- **Clic sur une puce** : son texte complet, tel qu'il partira. **✕** : la retire. **Vider** : les
  retire toutes. **Icône image** : envoie la puce sans son image (texte seul), et la remet d'un
  second clic.
- **Changer de livre** vide les puces en attente.

## 4. Ce que Claude reçoit sans que tu le demandes

- **Ta position** : la page (« p. 208 / 417 ») et la section.
- **Les pages autour de toi** (PDF) : cinq de chaque côté, chacune marquée de son numéro. Chaque page
  n'est envoyée qu'une fois par conversation ; quand tu avances, seules les nouvelles partent.
  **EPUB** : le chapitre en cours.
- **La liste des notations du livre**, s'il en a une (une annexe « Notation », « Symbols »…), au
  premier message de la conversation.
- **La ligne au-dessus de la saisie** dit tout cela : « p. 208 / 417 · 6.5 … · p. 203–213 jointes »,
  puis « pages déjà transmises ». Pendant la construction de l'index : « index du livre 40 % ».

## 5. Claude cherche dans le livre

- **À la première ouverture d'un livre**, l'app en construit un index, au repos, sans ralentir la
  lecture (environ une minute pour 600 pages ; la progression s'affiche). Ensuite, plus jamais.
- **Quand la question le demande** (« où est défini ⊗ ? », « que dit le livre sur … ? »), Claude
  cherche lui-même : un mot, une expression ou un symbole dans tout le livre, puis il lit les pages
  utiles. Pendant ce temps : « Recherche dans le livre : ⊗ ». Après, la recherche reste affichée
  au-dessus de sa réponse.
- **Quand la réponse est sous ses yeux** (sur ta page, ou « 2 + 2 »), il ne cherche pas.
- **Les résultats sont classés selon ta lecture** : les correspondances sûres d'abord, puis ce qui est
  près de ta page et dans ton chapitre, les définitions en tête. Un symbole à deux sens (⊗ : un groupe
  p. 42, le produit extérieur p. 172) donne d'abord le sens de l'endroit où tu lis.
- **Symboles abîmés par l'extraction** : chercher « ∫ » trouve aussi les « Z » du texte extrait ;
  une telle correspondance est signalée « à vérifier ».
- **« p. 42 » dans une réponse est un lien** (PDF) : un clic t'y amène. Les numéros sont ceux du PDF,
  même quand le livre imprime les siens décalés (MML imprime « 36 » sur la p. 42 du PDF).
- **Question posée pendant la construction de l'index** : Claude cherche dans ce qui est déjà indexé
  et te dit que la suite n'est pas encore couverte.

## 6. Pas de spoiler

- **L'app retient, pour chaque livre, la page la plus loin que tu as lue.** La ligne de contexte
  l'affiche : « lu jusqu'à p. 30 ».
- **Ce qui la fait avancer : lire à la suite depuis cette limite.** Tu es à la p. 30 (lu jusqu'à 30),
  tu passes à 31, 32… : elle suit. En mode deux pages, elle avance de deux.
- **Ce qui ne la fait pas avancer :**
  - un **saut** en avant (l'index du livre, une annexe, un lien « p. 209 » dans une réponse, la table
    des matières) : tu es p. 450, mais « lu jusqu'à » reste 30 ;
  - **feuilleter après un saut** : de 450 à 451, 452… en cherchant un mot dans l'index, elle reste 30 ;
  - **revenir en arrière** : de 30 à 20, elle reste 30 (elle ne recule jamais d'elle-même) ;
  - **rouvrir le livre** sur une page plus loin (fermé sur l'index la dernière fois) : elle reste.
- **Tu as vraiment sauté au chapitre 9 pour le lire ?** Clique sur « lu jusqu'à p. 30 » dans la ligne
  de contexte : la limite passe à la page affichée. Le même clic sert à corriger dans l'autre sens.
- **Livre entamé avant cette fonction** : la limite part de la page où tu es à la première ouverture.
- **Ce que Claude ne voit pas au-delà de la limite** : les résultats de recherche plus loin sont
  seulement comptés (« 3 occurrences plus loin, p. 209, 215 »), jamais montrés ; la lecture de ces
  pages lui est refusée. Les pages envoyées d'office s'arrêtent deux pages après la limite (une
  démonstration qui déborde). Les titres de la table des matières restent visibles.
- **Tu demandes une notion traitée plus loin** : Claude ne l'explique pas, même en termes généraux.
  Il dit « c'est traité plus loin, p. 209 : tu préfères aller voir cette page, ou une explication
  générale tout de suite ? ». Un bouton **« Regarder p. 209 »** apparaît sous sa réponse ; si tu
  réponds « explique-la en général », il l'explique sans puiser dans le livre.
- **Clic sur « Regarder p. 209 »** : Claude lit les p. 209 et 210, pour cette question seulement, et
  répond. À la question suivante, ces pages sont de nouveau fermées (mais il se souvient de ce qu'il
  y a lu dans cette conversation).
- **L'œil en haut du chat** (barré par défaut) : un clic autorise tout le livre, pour ce livre, jusqu'à
  ce que tu le recliques (utile pour une relecture). Le recliquer referme, mais Claude se souvient de
  ce qu'il a déjà lu dans la conversation : ouvre-en une nouvelle pour repartir propre.

## 7. Les réponses

- **Les mathématiques sont rendues** comme dans un livre (KaTeX). Une formule trop large défile dans
  sa bulle ; une formule mal écrite s'affiche en rouge sans casser le reste.
- **Sur un passage avec des mathématiques**, Claude commence par une ligne « Transcription » : la
  formule recopiée fidèlement, puis l'explication. **L'image du passage s'affiche juste au-dessus**
  de sa transcription, pour comparer d'un coup d'œil (« Transcription 1 », « 2 »… avec plusieurs
  passages).
- **Pour expliquer une formule**, il l'annote : chaque terme en couleur, légendé sous une accolade.
- **Le texte d'une réponse** se sélectionne et se copie normalement.

## 8. Limites connues

- Un PDF dont le texte est très mal balisé (TAPL) donne un texte extrait mélangé : l'image fait foi
  pour les passages ; la recherche dans le livre peut rater une expression.
- Dans un EPUB, les liens « p. N » ne sont pas cliquables et l'anti-spoiler compte en sections.
- Claude se souvient, dans une conversation, de ce qu'il a lu avant qu'une page soit refermée.
- Une longue conversation peut être résumée automatiquement par Claude Code ; il peut alors oublier
  des pages reçues, sans que l'app le sache.
