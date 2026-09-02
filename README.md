# MON Inbound

App mobile web (un seul fichier, sans build) pour planifier et suivre le déchargement des camions : la veille, quelqu'un saisit l'heure théorique d'arrivée (ETA) ; le lendemain, la personne au dock ouvre l'app, tape sur le camion, "Start Unloading", puis "Finish Unloading" une fois terminé.

Prototype réalisé comme exemple pour le département IT — pensé pour être repris et adapté librement.

## Structure du repo

```
mon-inbound/
├── index.html                 # l'app entière (HTML + CSS + JS, un seul fichier) — à déployer sur Netlify
├── README.md                  # ce fichier
└── google-apps-script/
    └── Code.gs                # backend optionnel : script Apps Script STANDALONE (pas lié au Sheet), voir plus bas
```

`index.html` est autonome : aucune dépendance, aucun build, aucun `package.json`. C'est le seul fichier que Netlify doit servir. `Code.gs` n'est PAS déployé par Netlify et n'est PAS collé dans l'éditeur Apps Script lié au Sheet (Extensions → Apps Script) — voir pourquoi et comment dans la section suivante, c'est un système séparé.

## Déployer le site sur Netlify

1. Pousser ce repo sur GitHub.
2. Sur Netlify : "Add new site" → "Import an existing project" → choisir ce repo GitHub.
3. Build command : laisser vide. Publish directory : `/` (racine du repo, là où se trouve `index.html`).
4. Déployer. Chaque futur `git push` redéploie automatiquement.

## Les deux rôles

- **Admin** : protégé par un code PIN (par défaut `1234`, modifiable dans l'app via l'icône ⚙ à côté du badge de rôle). Peut saisir/modifier l'ETA, ajouter/supprimer des camions (sauf en mode Google Sheet, voir plus bas), changer le PIN.
- **MHE Driver** : aucune connexion. Voit les camions du jour, démarre/termine le déchargement.

Le rôle est choisi une fois par téléphone (stocké localement sur l'appareil, pas de compte).

## Trois modes de stockage des données (détectés automatiquement)

1. **Google Sheet connecté** (recommandé pour un usage réel) — voir la section suivante.
2. **Claude Artifact** (aperçu live pendant le développement) — synchronisation via republication de l'artifact.
3. **Local (`localStorage`)** — fallback si ni Sheet ni Claude Artifact : les données restent dans le navigateur de l'appareil. C'est le mode actif par défaut si tu déploies `index.html` tel quel sur Netlify sans rien configurer d'autre.

## Connecter un Google Sheet (optionnel mais recommandé)

Fichier concerné : `google-apps-script/Code.gs`.

**Important : ce script est volontairement autonome ("standalone"), pas collé dans Extensions → Apps Script du Sheet.** Si le Sheet a déjà un script qui lui est lié (c'est le cas ici : "PP + SHIFT"), ce script possède déjà ses propres `doGet`/`doPost` — un projet ne peut en avoir qu'un seul de chaque. Coller `Code.gs` par-dessus casserait ce qui existe déjà. En le gardant standalone (il accède au Sheet par son ID plutôt que d'y être "attaché"), aucun risque de collision.

1. Aller sur https://script.google.com → New project.
2. Coller le contenu de `google-apps-script/Code.gs` (remplacer le code par défaut).
3. Vérifier `SHEET_ID` et `SHEET_GID` en haut du fichier (déjà pré-remplis pour le Sheet "NPA - INBOUND" ; `SHEET_GID` est l'id de l'onglet, visible dans l'URL du Sheet après `#gid=`).
4. Déployer → Nouveau déploiement → type "Web app" → Exécuter en tant que "Moi" → Accès "Tout le monde" → Déployer.
5. Autoriser les permissions demandées (utiliser un compte Google qui a au moins un accès en modification sur le Sheet). Un écran "Google n'a pas vérifié cette application" peut apparaître la première fois — c'est normal pour un script perso non publié : cliquer "Paramètres avancés" puis "Accéder à [nom du projet] (dangereux)".
6. Copier l'URL `/exec` obtenue.
7. Dans `index.html`, remplir la constante `SHEETS_WEBAPP_URL` (en haut du `<script>`) avec cette URL.
8. Commit + push → Netlify redéploie automatiquement.

Colonnes du Sheet attendues (repérées par nom d'en-tête, l'ordre n'a pas d'importance) :
`Reference ID, Order Date, IM/EX/TR, Truck No., Plant, LON/POS D/T, Act Arrival D/T, Act Dept D/T, Dur. (Hr:Min), LOF Location, Truck State, OBD, Cont No., Seal No., Cont Type, Closing Date, Remark, PO No., QTT, SKU No., Details`

L'app ne modifie que 5 colonnes existantes : `LON/POS D/T` (ETA), `Act Arrival D/T`, `Act Dept D/T`, `Dur. (Hr:Min)`, `Truck State` (valeurs écrites : `arrived` au démarrage, `completed` à la fin). Tout le reste est affiché en lecture seule sur la fiche du camion. En mode Sheet, le bouton d'ajout et la suppression de camion sont désactivés (les lignes existent déjà dans le Sheet).

### Photos d'arrivée / de fin (optionnel, mode Sheet uniquement)

Quand un Sheet est connecté, "Start Unloading" et "Finish Unloading" proposent d'abord de prendre une photo (ou de passer). Les photos sont enregistrées dans un dossier Drive ("MON Inbound Photos") créé automatiquement au premier envoi, dans le Drive du compte qui a déployé le script — rien à préparer à l'avance. Les liens sont écrits dans deux colonnes que le script ajoute lui-même au Sheet dès qu'elles servent : "Start Photo URL" et "Finish Photo URL".

### Bilingue thaï / anglais

L'interface est bilingue. Une petite pastille "TH／EN" en haut (dans l'écran de choix du rôle, et dans l'en-tête une fois un rôle choisi) permet de basculer la langue d'affichage à tout moment — ce n'est pas un compte, juste une préférence mémorisée sur l'appareil. Par défaut l'app démarre en **thaï** (la majorité des utilisateurs au quai ne lisent pas l'anglais) ; le management peut basculer en anglais en un tap. La date dans l'en-tête suit aussi la convention thaïe en mode thaï (jour de semaine + année bouddhiste, ex. "วันพุธที่ 2 กันยายน 2569"). Tous les textes de l'app (statuts, boutons, formulaires, messages d'erreur) sont traduits ; le nom de marque "MON Inbound" reste inchangé dans les deux langues.

### Retouche visuelle

Les tuiles de statistiques (Complétés / En cours / En retard) ont maintenant un fond teinté (vert / orange / rouge) au lieu d'un simple encadré, pour reprendre l'effet des tuiles colorées de ton dashboard TV. Cartes et boutons ont un léger relief (ombre douce) et une animation de pression au tap pour un rendu plus premium.

### Correctif affichage mobile (viewport)

Le fichier `index.html` déployé n'avait pas de balise `<meta name="viewport">` dans son vrai `<head>` (elle n'existait que dans le code utilisé pour la republication interne, jamais dans le fichier statique servi par Netlify). Résultat sur téléphone : Safari/Chrome mobile affichait la page comme une vue desktop dézoomée pour la faire tenir à l'écran, au lieu de l'afficher à la vraie échelle mobile. Le fichier est maintenant un document HTML5 complet et valide (`<!doctype html><html><head>` avec la balise viewport `width=device-width, initial-scale=1` `</head><body>...</body></html>`), donc l'app s'affiche désormais à taille réelle, comme une vraie app mobile. Vérifié avec un test automatisé à la taille d'un écran d'iPhone.

### Autres améliorations

- **Installable sur l'écran d'accueil (PWA légère)** : sur mobile, le navigateur propose "Ajouter à l'écran d'accueil" (icône, couleur de thème) — pas de service worker, pas de fichier séparé, tout est intégré dans `index.html`.
- **Nom de la personne (optionnel)** : au moment de démarrer/terminer un déchargement (mode Sheet), un champ "Your name" propose de s'identifier. Le nom est mémorisé sur l'appareil (pas de compte) et réutilisé aux prochaines actions. Il est écrit dans le Sheet dans deux colonnes créées automatiquement : "Started By" et "Finished By".
- **Retour vibratoire** : léger vibreur au tap sur les actions principales (Start/Finish, confirmer/passer la photo) — juste un repère tactile, désactivé silencieusement si l'appareil ne le supporte pas.
- **Nouvelle tentative en cas d'échec réseau** : si l'enregistrement dans le Sheet échoue (coupure réseau, etc.), un bouton "Retry" apparaît dans le message d'erreur et relance exactement la même action.
- **Protection contre les doubles actions simultanées** : si deux personnes agissent sur le même camion en même temps (ex. deux chauffeurs tapent "Start" en même temps), le script refuse la deuxième action et l'app se resynchronise automatiquement avec le Sheet plutôt que d'écraser l'état.
- **Rafraîchissement au retour sur l'app** : quand le téléphone se réveille ou qu'on revient sur l'onglet, les données se resynchronisent avec le Sheet automatiquement.

## Pour l'équipe IT

Tout le code est commenté. Points d'entrée utiles si vous adaptez l'app :
- `index.html` : un seul `<script>`, logique organisée en sections (constantes, état, rendu, actions, événements). La fonction `render()` reconstruit tout le HTML de l'app à chaque changement d'état — pas de framework.
- `google-apps-script/Code.gs` : `doGet` (lecture) / `doPost` (écriture), colonnes repérées par nom via `COLS` (facile à adapter si les colonnes du Sheet changent).
