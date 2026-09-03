# MON Inbound

App mobile web (sans build, sans framework) pour planifier et suivre le déchargement des camions : la veille, quelqu'un saisit l'heure théorique d'arrivée (ETA) ; le lendemain, la personne au dock ouvre l'app, tape sur le camion, "Start Unloading", puis "Finish Unloading" une fois terminé. Les photos prises par les chauffeurs MHE sont stockées dans Supabase.

Prototype réalisé comme exemple pour le département ISD — pensé pour être repris et adapté librement.

## Structure du repo

```
mon-inbound/
├── index.html                 # coquille HTML : <head>, #app, balises <script> — à déployer sur Netlify
├── manifest.webmanifest       # manifeste PWA (installable sur l'écran d'accueil)
├── icons/
│   ├── favicon.png            # icône d'onglet / apple-touch-icon
│   ├── icon-192.png           # icône PWA 192×192
│   └── icon-512.png           # icône PWA 512×512
├── css/
│   └── app.css                # toute la feuille de style (inchangée, juste extraite)
├── js/
│   ├── config.js              # constantes : URL/clé Supabase, intervalles, libellés de calendrier
│   ├── dateUtils.js           # helpers de date/formatage, sans aucune dépendance
│   ├── storage.js             # localStorage : rôle, langue, nom retenu, données locales de secours
│   ├── i18n.js                # dictionnaire bilingue TH/EN + tr(key)
│   ├── state.js               # state (persisté) + ui (affichage) — les deux objets partagés
│   ├── status.js              # calcul du statut dérivé d'un camion (pending/late/done/…)
│   ├── api.js                 # couche Supabase : REST (PostgREST) + Storage, sans SDK
│   ├── importPlan.js          # feature "Import inbound plan" (Excel/CSV → camions, groupés en lots)
│   ├── importWorker.js        # parsing Excel en arrière-plan (Web Worker) pour ne pas geler la page
│   ├── photoUtils.js          # vibreur + redimensionnement/compression des photos
│   ├── render.js              # tout le HTML de l'app (aucun framework, un render() par changement)
│   ├── actions.js             # toutes les actions déclenchées par l'utilisateur
│   ├── ticking.js             # horloge live + timer d'un déchargement en cours
│   ├── events.js              # un seul écouteur de clic/clavier/changement, routé par data-*
│   ├── seedData.js            # jeu de données de démo optionnel (non appelé par défaut)
│   └── main.js                # point d'entrée : câble tout et démarre l'app
├── README.md                  # ce fichier
└── supabase-schema.sql        # à exécuter une fois dans l'éditeur SQL de ton projet Supabase
```

Toujours **zéro build, zéro `package.json`, zéro bundler** : `index.html` charge `js/main.js` avec `<script type="module">`, et le navigateur résout tout seul les `import`/`export` entre les fichiers — exactement comme avant, juste réparti dans plusieurs fichiers au lieu d'un seul. Netlify (ou n'importe quel hébergeur de fichiers statiques) sert ce dossier tel quel, sans aucune étape de compilation.

Seule dépendance externe : [SheetJS](https://sheetjs.com/) chargée depuis un CDN (cdnjs), utilisée uniquement par l'écran "Import inbound plan" (voir plus bas) — le reste de l'app ne dépend de rien d'externe.

## Déployer le site sur Netlify

1. Pousser ce repo sur GitHub (avec tous ses dossiers `js/`, `css/`, `icons/`).
2. Sur Netlify : "Add new site" → "Import an existing project" → choisir ce repo GitHub.
3. Build command : laisser vide. Publish directory : `/` (racine du repo, là où se trouve `index.html`).
4. Déployer. Chaque futur `git push` redéploie automatiquement.

## Les deux rôles

- **Admin** : protégé par un code PIN (par défaut `1234`, modifiable dans l'app via l'icône ⚙ à côté du badge de rôle). Peut saisir/modifier l'ETA, ajouter/supprimer des camions, importer le planning, changer le PIN.
- **MHE Driver** : aucune connexion. Voit les camions du jour, démarre/termine le déchargement, ajoute des photos. Peut renseigner son nom une fois (pastille "👤 Name" à côté du badge de rôle) — mémorisé sur l'appareil, pas un compte.

Le rôle est choisi une fois par téléphone (stocké localement sur l'appareil, pas de compte).

## Deux modes de stockage des données (détectés automatiquement)

1. **Supabase connecté** (recommandé, voir plus bas) — tous les téléphones voient les mêmes camions et les mêmes photos.
2. **Local (`localStorage`)** — fallback tant que Supabase n'est pas configuré : les données restent dans le navigateur de cet appareil uniquement. C'est le mode actif par défaut si `SUPABASE_URL`/`SUPABASE_ANON_KEY` sont vides dans `js/config.js` — pratique pour prévisualiser le rendu pendant que le projet Supabase se met en place.

## Connecter Supabase

Fichier concerné : `supabase-schema.sql`.

1. Créer un compte / projet sur https://supabase.com si ce n'est pas déjà fait.
2. Dans le projet → **SQL Editor** → New query → coller tout le contenu de `supabase-schema.sql` → Run. Ça crée les deux tables (`trucks`, `photos`), les autorise en lecture/écriture pour la clé publique de l'app (voir la note de sécurité en haut du fichier SQL — c'est un prototype sans login, donc pas de vraie sécurité côté données), et crée le bucket de stockage `inbound-photos` pour les photos.
3. Dans le projet → **Settings** → **API** : copier l'**URL** du projet et la clé **anon public**.
4. Dans `js/config.js`, tout en haut du fichier, renseigner :
   ```js
   export const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...";
   ```
5. Commit + push → Netlify redéploie automatiquement.

Une fois branché, ajouter un camion se fait directement depuis l'app (bouton "+", rôle Admin). Pour importer le planning en masse (le fichier Excel du manager), voir la section suivante.

### Importer le planning (Excel/CSV) — rôle Admin

Pastille "📥" à côté du badge de rôle (Admin uniquement) → "Import inbound plan". Le manager choisit directement son fichier Excel existant (ex. "Incoming plan AMATA.xlsx") — rien n'est envoyé nulle part avant confirmation, tout est lu dans le navigateur (librairie [SheetJS](https://sheetjs.com/), chargée depuis un CDN). Toute la logique de cette feature vit dans `js/importPlan.js`.

Le fichier réel de MON (`Incoming plan AMATA`) a été utilisé comme référence pour construire ce parseur ; il gère ses particularités :
- Les en-têtes de colonnes sont en thaï/anglais et détectés par mot-clé (pas par position) — la ligne d'en-tête elle-même est repérée automatiquement même quand il y a des lignes vides/titres au-dessus.
- Les feuilles "master log" grossissent indéfiniment (des années d'historique dans un seul onglet) : un filtre "à partir de cette date" (par défaut aujourd'hui) écarte l'historique pour ne garder que les camions à venir.
- Chaque feuille du classeur est proposée à cocher ; par défaut sont pré-cochées les feuilles dont le nom contient "incoming" (insensible à la casse) hors variante "รปภ" (vue simplifiée pour la sécurité, redondante avec la feuille complète) — donc typiquement "RM PM incoming" + "Indirect incoming", pas "MON+PALLET" (qui est de l'export, hors périmètre de cette app) ni "Master data".
- Les doublons (même PO + même date + même heure + même transporteur) déjà présents dans l'app ne sont pas réimportés — on peut réimporter le même fichier mis à jour sans dupliquer les camions déjà créés.
- **Un même camion peut porter plusieurs lots** : dans le fichier réel, il arrive qu'une même livraison (même PO + même date + même heure + même transporteur) occupe plusieurs lignes — un numéro de ligne ("รายการ") différent par lot, avec son propre produit/quantité. Ces lignes sont regroupées en **un seul camion** avec la liste de ses lots (au lieu d'être traitées comme des camions séparés, ou pire, silencieusement réduites à une seule ligne) — voir plus bas.
- Le type de matière (RM/PM, colonne de gauche) est préservé comme préfixe dans le champ "Produit" (ex. "[RM] Poultry Meal…") ; le champ Plant est renseigné automatiquement à "AMATA" (nom du site dans ce fichier) — à ajuster si le classeur change de site.

Un écran d'aperçu montre le nombre de camions prêts à importer avant toute écriture (avec un badge "N lots" sur les lignes concernées) — rien n'est créé sans avoir cliqué sur "Importer".

**Aucune colonne n'est perdue** : en plus des champs ci-dessus (transporteur, PO, quantité, produit, date, heure, remarque), *toutes* les colonnes du fichier source sont sauvegardées telles quelles dans une colonne `raw` (JSON), y compris celles sans champ dédié dans l'app (pesée, poids brut, ponctualité, pénalités de retard…). Il faut avoir exécuté la mise à jour du schéma pour que cette colonne existe (voir `supabase-schema.sql` — `alter table public.trucks add column if not exists raw jsonb;`, à exécuter une fois si tu avais déjà lancé le script avant). Si elle n'existe pas encore, l'import fonctionne quand même (juste sans ce filet de sécurité) et te le signale dans le message de confirmation. Une fois présente, chaque camion importé affiche une section repliable "Toutes les données du fichier source" dans sa fiche.

**Lots multiples par camion** : quand plusieurs lignes du fichier partagent le même PO + date + heure + transporteur, elles deviennent un seul camion dont la colonne `lots` (JSON, voir `supabase-schema.sql` — même mécanique de mise à jour que `raw`) liste chaque lot (produit, quantité, référence, remarque, ses propres colonnes brutes). La fiche du camion affiche alors une section "Lots on this truck" listant chacun, et sa carte porte un badge "N lots" — un camion à un seul lot (le cas courant) n'affiche ni l'un ni l'autre et se comporte exactement comme avant. Comme pour `raw`, si la colonne `lots` n'existe pas encore côté Supabase, l'import fonctionne quand même : seul le premier lot de chaque camion est alors sauvegardé, avec un message te le signalant.

**Lecture du fichier en arrière-plan (`js/importWorker.js`)** : sur un gros fichier "master log" (des années d'historique, plusieurs dizaines de Mo), l'analyse du classeur Excel (`XLSX.read()` + extraction des feuilles) est du calcul pur et peut prendre du temps — fait sur le fil principal, ça gelait la page (plus de scroll, plus de réponse au tap) pendant toute la durée. Ce parsing tourne maintenant dans un Web Worker (`js/importWorker.js`, qui charge la même librairie SheetJS depuis le même CDN) : la page reste réactive (le bandeau "Reading…" s'anime normalement) pendant que le fichier est lu. Si le Worker n'est pas disponible, ou que le CDN ne répond pas (réseau bloqué/lent — le `import*Worker*` bascule après 6 secondes sans réponse), l'import repasse automatiquement sur le fil principal exactement comme avant : c'est une amélioration de fluidité, jamais une dépendance dure — l'import fonctionne dans tous les cas.

### Photos (mode test)

Quand Supabase est connecté, une section "Photos" apparaît sur la fiche de chaque camion : un chauffeur MHE (ou l'admin) peut ajouter jusqu'à 20 photos (`MAX_PHOTOS_PER_TRUCK` dans `js/config.js` — un seul endroit à changer si ce plafond doit encore bouger), à tout moment, dans n'importe quel ordre — ce n'est pas lié aux boutons Start/Finish. Le sélecteur permet de choisir plusieurs photos d'un coup (pas obligé de répéter l'opération une par une) ; s'il reste moins de slots que de photos sélectionnées, les premières sont ajoutées et un message précise combien ont été ignorées. Les photos sont redimensionnées/compressées dans le navigateur (max 1280px, JPEG qualité ~0.72, voir `js/photoUtils.js`) avant l'envoi pour rester légères en 4G, puis stockées dans le bucket Supabase `inbound-photos` (public, lecture directe par URL) sous `<id du camion>/<PO ou référence>-<timestamp>-<aléatoire>.jpg` — le dossier reste l'UUID du camion (garanti unique même si deux camions partagent le même n° de PO), seul le nom de fichier reprend le PO pour rester lisible en parcourant le bucket depuis le dashboard Supabase. Chaque photo garde une trace de qui l'a ajoutée (le nom renseigné côté chauffeur, optionnel).

C'est explicitement en **mode test** : la clé anon donne un accès public en lecture/écriture au bucket et aux tables (voir la note de sécurité dans `supabase-schema.sql`) — largement suffisant pour un mockup, mais à ne pas considérer comme sécurisé pour de la donnée sensible.

## Bilingue thaï / anglais

L'interface est bilingue (dictionnaire complet dans `js/i18n.js`). Une petite pastille "TH／EN" en haut (dans l'écran de choix du rôle, et dans l'en-tête une fois un rôle choisi) permet de basculer la langue d'affichage à tout moment — ce n'est pas un compte, juste une préférence mémorisée sur l'appareil. Par défaut l'app démarre en **thaï** (la majorité des utilisateurs au quai ne lisent pas l'anglais) ; le management peut basculer en anglais en un tap. La date dans l'en-tête suit aussi la convention thaïe en mode thaï (jour de semaine + année bouddhiste, ex. "วันพุธที่ 3 กันยายน 2569"). Tous les textes de l'app (statuts, boutons, formulaires, messages d'erreur) sont traduits ; le nom de marque "MON Inbound" reste inchangé dans les deux langues.

## Design

Refonte complète du visuel : couleur de marque alignée sur le bleu MON (`#004990`), tuiles de statistiques teintées (vert / orange / rouge), cartes et boutons avec relief et animation de pression au tap, bouton d'ajout (FAB) en accent ambre pour bien ressortir. Pensé pour un vrai rendu d'app mobile (viewport correct, pas de "vue PC dézoomée") plutôt qu'un site web responsive générique. Tout est dans `css/app.css`.

## Autres fonctionnalités

- **Installable sur l'écran d'accueil (PWA)** : `manifest.webmanifest` + les icônes dans `icons/` — sur mobile, le navigateur propose "Ajouter à l'écran d'accueil".
- **Retour vibratoire** : léger vibreur au tap sur Start/Finish (`js/photoUtils.js`, fonction `buzz()`).
- **Nouvelle tentative en cas d'échec réseau** : si l'enregistrement échoue (coupure réseau, etc.), un bouton "Retry" apparaît dans le message d'erreur et relance exactement la même action.
- **Protection contre les doubles actions simultanées** : si deux personnes agissent sur le même camion en même temps (ex. deux chauffeurs tapent "Start" en même temps), la deuxième action est refusée côté Supabase (mise à jour conditionnelle : "ne modifie que si l'état n'a pas changé entre-temps") et l'app se resynchronise automatiquement plutôt que d'écraser l'état.
- **Rafraîchissement au retour sur l'app** : quand le téléphone se réveille ou qu'on revient sur l'onglet, les données se resynchronisent avec Supabase automatiquement.
- **Rafraîchissement en douceur** : `render()` reconstruit tout le HTML à chaque cycle (voir plus bas) — sans précaution, ça remettait le scroll en haut de la page à chaque rafraîchissement périodique (~15s), ce qui donnait une impression de "saut violent" en lisant la liste. La position de scroll est maintenant conservée à travers chaque rafraîchissement. Par ailleurs, tant qu'une fiche camion est ouverte (n'importe quel rôle, n'importe quel statut — même un camion "terminé" qu'on est juste en train de consulter), le rafraîchissement périodique est mis en pause pour ne pas fermer une section dépliée ("Lots on this truck", "Toutes les données du fichier source") ni interrompre la lecture ; il reprend dès la fermeture de la fiche.
- **Bandeau bleu qui respecte l'encoche/barre de statut du téléphone** : quand l'app est installée sur l'écran d'accueil (`manifest.webmanifest`, `"display": "standalone"`), elle prend tout l'écran y compris la zone de la barre de statut — sans précaution, le contenu du bandeau bleu du haut (nom, horloge, date) se retrouvait collé sous/derrière l'heure et les icônes du téléphone. `css/app.css` (`.topbar`) ajoute maintenant `env(safe-area-inset-top)` à son padding du haut pour que son propre contenu commence toujours après cette zone, quel que soit le téléphone (ne change rien sur un appareil sans encoche/barre superposée, où `env()` vaut 0).
- **Heure prévue toujours visible sur la carte** : une fois un camion "en retard", la pastille de statut affiche les minutes de retard à la place de l'heure — l'heure prévue (ETA) reste donc affichée séparément sur la carte, pour ne jamais la perdre de vue même très en retard.

## Pour l'équipe ISD

Le code est réparti par responsabilité (voir la structure du repo ci-dessus), sans framework — pas de build à maintenir, juste des modules ES natifs que le navigateur charge directement :

- **`js/state.js`** : les deux objets partagés par toute l'app — `state` (les camions + le code admin, persistés) et `ui` (tout ce qui concerne l'écran en cours, jamais persisté). Toutes les autres modules les importent et les mutent directement (`ui.tab = "today"`, etc.) — c'est le seul endroit qui les définit.
- **`js/render.js`** : la fonction `render()` reconstruit tout le HTML de l'app à chaque changement d'état et l'écrit dans `#app` — pas de framework, pas de diffing.
- **`js/actions.js`** : toute mutation déclenchée par l'utilisateur (ETA, start/finish/reopen, ajout/suppression de camion, photos, PIN). Les appels réseau passent par `js/api.js` : `sbRest()` (table `trucks`/`photos` via l'API REST de Supabase, PostgREST) et `sbUploadPhoto()`/`sbDeletePhoto()` (API Storage) — pas de SDK à installer.
- **`js/events.js`** : le seul point où les clics/claviers/changements du DOM sont écoutés, routés par attribut `data-*` vers la fonction de `actions.js` ou `importPlan.js` correspondante.
- **`supabase-schema.sql`** : les deux tables, leurs policies, et le bucket de stockage.
- Le formulaire "New Truck" dans l'app ne couvre que les champs essentiels (transporteur, plant, référence PO, date, ETA) ; les champs plus détaillés (SKU, quantité, conteneur…) peuvent être renseignés directement dans Supabase (Table Editor) si besoin, ou le formulaire peut être étendu facilement dans `addSheetHtml()` (`js/render.js`) / `createTruck()` (`js/actions.js`).
- Import Excel/CSV : tout `js/importPlan.js`, fonctions préfixées `import*` (détection d'en-tête `importFindHeaderRow()`, association des colonnes `importDetectColumnMap()`/`IMPORT_FIELD_MATCHERS`, extraction `importExtractRows()`). Le mapping de colonnes est piloté par mots-clés, pas par position — pour l'adapter à un autre format de fichier, il suffit d'ajouter des variantes de libellés dans `IMPORT_FIELD_MATCHERS`. L'écran lui-même (`importSheetHtml()`) est dans `js/render.js`.
- Traductions : tout est dans `js/i18n.js` (`STRINGS` + `tr(key)`) — ajouter une clé là-bas suffit pour qu'elle soit disponible partout ailleurs via `tr("maCle")`.
