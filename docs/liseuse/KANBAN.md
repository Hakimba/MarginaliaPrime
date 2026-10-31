# Kanban — déclinaison liseuse de MarginaliaPrime

Règle du jeu : l'app de bureau ne change pas de comportement. Tout ce qui est partagé est
extrait, pas dupliqué.

Colonnes : **À décider** → **Prêt** → **En cours** → **Revue** → **Fait**.

Taille : S ≈ une demi-journée, M ≈ 1–2 jours, L ≈ 3–5 jours, XL ≈ une semaine et plus.

---

## À décider (bloque le reste)

| # | Carte | Taille | Fini quand |
|---|---|---|---|
| D1 | Contrat d'API du serveur : route standard `/v1/chat/completions` + route maison `/marginalia/ask`, jeton d'appairage | S | un document d'une page, les deux routes figées |
| D2 | Format des données par livre (index, état de lecture, glossaire, conversations) identique au bureau | S | on sait quels fichiers sont partagés et lesquels ne le sont pas |
| D3 | Le moteur : abonnement/API d'un modèle donné, en HTTP ou via un CLI | S | on sait s'il y a un processus enfant ou un appel HTTP |
| D4 | Client : KOReader d'abord ; l'APK Marginalia Android reste un repli | S | décision écrite, pas de travail lancé sur les deux |

## Prêt / Backlog — fondations

| # | Carte | Taille | Dépend de | Fini quand |
|---|---|---|---|---|
| F1 | Extraire harnais + plan du tour + lecture du flux dans un paquet partagé, consommé par le bureau | M | D2 | le bureau utilise le paquet et ses tests passent sans modification |
| F2 | Garde-fou CI : les tests du bureau restent verts, aucune fonction visible ne change | S | F1 | CI verte, revue à l'œil du bureau |
| F3 | Abstraction moteur : interface, adaptateur « CLI » (celui d'aujourd'hui), adaptateur « HTTP compatible OpenAI » | M | D3 | on peut changer de moteur par configuration |
| F4 | Variante de harnais « liseuse » : réponses courtes, pas de tableaux, termes numérotés au lieu des couleurs | S | F1 | deux harnais, un par contexte, choisis à l'exécution |

## Serveur v0 — le tuyau

| # | Carte | Taille | Dépend de | Fini quand |
|---|---|---|---|---|
| S1 | Service HTTP : liste des modèles, conversation en flux, erreurs lisibles | M | D1 | une réponse s'affiche sur la liseuse depuis le greffon stock |
| S2 | Cycle de vie du moteur : un processus ou une session par conversation, arrêt propre | M | F3 | pas de fuite de processus, reprise après plantage |
| S3 | Bouchon de test et journal des requêtes (déjà écrit : `scripts/mock-openai-server.py`) | S | — | on voit en clair ce que le client envoie |

## Serveur v1 — il connaît le livre

| # | Carte | Taille | Dépend de | Fini quand |
|---|---|---|---|---|
| L1 | Veille de la bibliothèque : détecte un nouveau livre, le met en file d'indexation | M | D2 | un livre déposé est indexé sans intervention |
| L2 | Extracteur PDF côté serveur : texte page par page, table des matières, décalage de numérotation | L | L1 | index complet d'un livre de 600 pages en moins de deux minutes |
| L3 | Extracteur EPUB côté serveur : sections et titres | M | L1 | index d'un EPUB sans navigateur |
| L4 | Recherche, pages, table des matières : brancher le serveur d'outils qui tourne déjà sans fenêtre | M | L2 | une question « où est défini ⊗ ? » renvoie les bonnes pages |
| L5 | Routage des outils selon le moteur (outils MCP ou appels de fonction) | L | F3, L4 | les deux familles de moteurs peuvent chercher dans le livre |
| L6 | Image de la page jointe à la question (rendu, compression, taille raisonnable) | M | L2 | une formule illisible en texte est lue correctement |
| L7 | État de lecture et anti-spoiler côté serveur, alimentés par la page du client | M | L4 | au-delà de la limite, recherche et pages sont refusées |
| L8 | Glossaire partagé : lecture, écriture, fusion, anti-spoiler appliqué | M | L1 | une entrée ajoutée sur la liseuse apparaît sur le bureau |
| L9 | Conversations persistées par livre, reprise après redémarrage | M | S2 | on rouvre le livre et la conversation continue |

## Client — fork léger du greffon KOReader

| # | Carte | Taille | Dépend de | Fini quand |
|---|---|---|---|---|
| C1 | Fork, préréglage fournisseur « Marginalia » (adresse + jeton), sans clavier | S | S1 | on se connecte en trois appuis |
| C2 | Envoi de l'identité du livre et de la page courante | S | D1 | le serveur sait quel livre et quelle page |
| C3 | Bouton **Joindre** : plusieurs passages, puces ①②, envoi groupé | M | C2 | deux passages de chapitres différents partent ensemble |
| C4 | Menu **Σ** : formules détectées de la page, choix dans une liste | M | L6 | une formule choisie arrive avec son image |
| C5 | Onglet **Glossaire**, saut à la page d'une définition | M | L8 | le glossaire se consulte sans le chat |
| C6 | Liens « p. N » d'une réponse qui ouvrent la page | S | C2 | un appui saute à la page citée |
| C7 | Affichage des images de formules dans la réponse | M | L6 | une image s'affiche proprement sur l'e-ink |
| C8 | Tests headless du greffon | S | C1 | les fonctions pures sont testées hors appareil |

## Format et confort

| # | Carte | Taille | Dépend de | Fini quand |
|---|---|---|---|---|
| P1 | Règles de réponse liseuse : longueur plafonnée, pas de tableaux larges | S | F4 | trois réponses types tiennent sur un écran |
| P2 | Maths : Unicode par défaut, image de formule en secours | M | C7 | une intégrale et une matrice sont lisibles |
| P3 | Essai à l'œil sur l'appareil, liste de défauts priorisée | S | C3, C4, C5 | liste courte, priorisée, avec captures |

## Exploitation

| # | Carte | Taille | Dépend de | Fini quand |
|---|---|---|---|---|
| O1 | Déploiement sur le homelab : conteneur, configuration, chemins, jeton | M | S1 | `docker compose up` suffit |
| O2 | Journal et diagnostic : voir ce qui part, ce qui revient, ce qui coûte | S | S1 | une question ratée se diagnostique sans lire le code |
| O3 | Documentation d'installation et de mise à jour, sans casser le bureau | S | O1 | une page suffit à réinstaller |

## Plus tard (ne pas commencer)

| # | Carte | Taille |
|---|---|---|
| X1 | APK Marginalia Android comme client (repli si l'e-ink du greffon déçoit) | XL |
| X2 | Modèle local (Ollama) pour les livres sans maths | M |
| X3 | Sélection multi-pages native dans KOReader | M |

---

## Risques à mesurer tôt

1. **Outils du livre avec un modèle non-Claude.** Chercher dans le livre exige que le modèle
   appelle correctement des outils. À mesurer sur un livre réel avant d'écrire tout le reste
   (carte L5) : si ça ne marche pas, la recherche devient une étape imposée par le serveur.
2. **Qualité des maths.** Un modèle plus faible recopie moins fidèlement les formules ; la
   transcription en LaTeX est la première à souffrir. À mesurer aussi tôt.
3. **Fidélité du texte extrait.** Déjà connu sur le bureau ; l'image de page est la parade (L6).
4. **E-ink et latence.** Une réponse longue met 20 s à arriver : le flux est indispensable (S1).
