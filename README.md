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
│   ├── icon-512.png           # icône PWA 512×512
│   └── mark-full.png          # logo complet (hexagone + "MON", couleurs d'origine) affiché dans le bandeau bleu du haut
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

- **Admin** : protégé par un code PIN à 6 chiffres minimum (par défaut `748231`, modifiable dans l'app via l'icône ⚙ à côté du badge de rôle). Peut saisir/modifier l'ETA, ajouter/supprimer des camions, importer le planning, changer le PIN.
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
- Le type de matière (RM/PM, colonne de gauche) est préservé comme préfixe dans le champ "Produit" (ex. "[RM] Poultry Meal…") ; le champ Plant est proposé dans un champ éditable sur l'écran d'import (par défaut "AMATA", le nom du site dans le fichier de référence), mémorisé sur l'appareil d'un import à l'autre — voir "Plusieurs sites (Round 16)" plus bas.

Un écran d'aperçu montre le nombre de camions prêts à importer avant toute écriture (avec un badge "N lots" sur les lignes concernées) — rien n'est créé sans avoir cliqué sur "Importer".

**Aucune colonne n'est perdue** : en plus des champs ci-dessus (transporteur, PO, quantité, produit, date, heure, remarque), *toutes* les colonnes du fichier source sont sauvegardées telles quelles dans une colonne `raw` (JSON), y compris celles sans champ dédié dans l'app (pesée, poids brut, ponctualité, pénalités de retard…). Il faut avoir exécuté la mise à jour du schéma pour que cette colonne existe (voir `supabase-schema.sql` — `alter table public.trucks add column if not exists raw jsonb;`, à exécuter une fois si tu avais déjà lancé le script avant). Si elle n'existe pas encore, l'import fonctionne quand même (juste sans ce filet de sécurité) et te le signale dans le message de confirmation. Une fois présente, chaque camion importé affiche une section repliable "Toutes les données du fichier source" dans sa fiche.

**Lots multiples par camion** : quand plusieurs lignes du fichier partagent le même PO + date + heure + transporteur, elles deviennent un seul camion dont la colonne `lots` (JSON, voir `supabase-schema.sql` — même mécanique de mise à jour que `raw`) liste chaque lot (produit, quantité, référence, remarque, ses propres colonnes brutes). La fiche du camion affiche alors une section "Lots on this truck" listant chacun, et sa carte porte un badge "N lots" — un camion à un seul lot (le cas courant) n'affiche ni l'un ni l'autre et se comporte exactement comme avant. Comme pour `raw`, si la colonne `lots` n'existe pas encore côté Supabase, l'import fonctionne quand même : seul le premier lot de chaque camion est alors sauvegardé, avec un message te le signalant.

**Lecture du fichier en arrière-plan (`js/importWorker.js`)** : sur un gros fichier "master log" (des années d'historique, plusieurs dizaines de Mo), l'analyse du classeur Excel (`XLSX.read()` + extraction des feuilles) est du calcul pur et peut prendre du temps — fait sur le fil principal, ça gelait la page (plus de scroll, plus de réponse au tap) pendant toute la durée. Ce parsing tourne maintenant dans un Web Worker (`js/importWorker.js`, qui charge la même librairie SheetJS depuis le même CDN) : la page reste réactive (le bandeau "Reading…" s'anime normalement) pendant que le fichier est lu. Si le Worker n'est pas disponible, ou que le CDN ne répond pas (réseau bloqué/lent — le `import*Worker*` bascule après 6 secondes sans réponse), l'import repasse automatiquement sur le fil principal exactement comme avant : c'est une amélioration de fluidité, jamais une dépendance dure — l'import fonctionne dans tous les cas.

### Plusieurs sites (Round 16)

Le champ "Plant" de l'écran d'import n'est plus figé sur "AMATA" en dur dans le code : c'est maintenant un champ texte éditable (pré-rempli à "AMATA" par défaut), mémorisé sur l'appareil (`localStorage`) d'un import à l'autre — pratique si MON Logistics importe un jour le planning d'un autre site depuis le même téléphone/tablette, sans toucher au code. Aucun changement de comportement pour un usage à un seul site : la valeur par défaut reste "AMATA".

### Tenir la charge dans le temps (Round 16)

Les écrans du jour (Hier/Aujourd'hui/Demain + les flèches ◀/▶, voir plus haut) n'affichent jamais plus d'une fenêtre de ±`MAX_DAY_OFFSET` jours autour d'aujourd'hui. `loadFromSupabase()` (`js/api.js`) ne charge donc plus non plus toute la table `trucks` à chaque rafraîchissement : la requête est bornée côté serveur à cette même fenêtre de dates (`order_date=gte....&order_date=lte....`), pour que la taille des données transférées à chaque poll (~15s) reste petite et constante, quel que soit le volume d'historique déjà accumulé dans Supabase au fil des mois. Les deux seuls écrans qui ont légitimement besoin de regarder en dehors de cette fenêtre (la détection de doublons à l'import, et l'écran Reporting ci-dessous) utilisent chacun leur propre requête à plage explicite (`sbFetchTrucksInRange`/`sbFetchTrucksForReport` dans `js/api.js`) plutôt que de dépendre des données déjà chargées à l'écran.

### Écran Reporting (Round 16) — rôle Admin

Nouvelle pastille "📊" à côté du badge de rôle (Admin uniquement), à côté de l'icône ⚙. Elle ouvre un écran de synthèse sur une plage de dates choisie (par défaut les 7 derniers jours) : nombre de camions, nombre terminés, taux de ponctualité (arrivée réelle comparée à l'ETA, avec la même tolérance `GRACE_MIN` que le statut "late" des cartes), durée moyenne de déchargement (entre "Start" et "Finish"), nombre de remarques de dommage renseignées, et nombre de camions sans arrivée enregistrée (indicateur de qualité de saisie). Toute la logique vit dans `js/reporting.js` ; la requête est indépendante de la fenêtre d'affichage du jour (voir ci-dessus) et ne charge que les colonnes nécessaires au calcul.

**Export CSV (Round 17)** : un bouton "Export CSV" apparaît une fois le rapport généré, sous les tuiles de KPI. Il télécharge directement dans le navigateur (aucun aller-retour serveur supplémentaire — les mêmes lignes que celles qui ont servi au calcul des KPI, déjà en mémoire) un fichier `mon-inbound-report_<du>_<au>.csv` avec une ligne par camion (date, ETA, statut, heures réelles d'arrivée/départ, remarque de dommage), pour retravailler les chiffres dans Excel plutôt que de tout retaper depuis l'écran. BOM UTF-8 en tête du fichier pour qu'Excel l'ouvre correctement.

### Photos (mode test)

Quand Supabase est connecté, une section "Photos" apparaît sur la fiche de chaque camion : un chauffeur MHE (ou l'admin) peut ajouter jusqu'à 40 photos (`MAX_PHOTOS_PER_TRUCK` dans `js/config.js` — un seul endroit à changer si ce plafond doit encore bouger ; relevé de 20 à 40 au Round 13, suite au retour de Khun Badeeson qui en prend souvent beaucoup par expédition), à tout moment, dans n'importe quel ordre — ce n'est pas lié aux boutons Start/Finish. Le sélecteur permet de choisir plusieurs photos d'un coup (pas obligé de répéter l'opération une par une) ; s'il reste moins de slots que de photos sélectionnées, les premières sont ajoutées et un message précise combien ont été ignorées. Les photos sont redimensionnées/compressées dans le navigateur (max 1280px, JPEG qualité ~0.72, voir `js/photoUtils.js`) avant l'envoi pour rester légères en 4G, puis stockées dans le bucket Supabase `inbound-photos` (public, lecture directe par URL) sous `<id du camion>/<PO ou référence>-<timestamp>-<aléatoire>.jpg` — le dossier reste l'UUID du camion (garanti unique même si deux camions partagent le même n° de PO), seul le nom de fichier reprend le PO pour rester lisible en parcourant le bucket depuis le dashboard Supabase. Chaque photo garde une trace de qui l'a ajoutée (le nom renseigné côté chauffeur, optionnel).

### Remark de dommage / réclamation (Round 13)

En plus du champ "Remark" importé du fichier Excel (lecture seule, propre à chaque lot), la fiche camion propose maintenant une zone de texte libre "Remark (damage / claim note)" — un seul champ par camion, modifiable à tout moment par n'importe qui (Admin ou chauffeur), utile pour noter par exemple à quel niveau/couche du conteneur un dommage a été trouvé, en vue d'une réclamation auprès du fournisseur. Stocké dans `trucks.damage_remark` (voir `supabase-schema.sql` — `alter table ... add column if not exists damage_remark text;`, à exécuter une fois si le schéma avait déjà été lancé avant ce round). Si cette colonne n'existe pas encore côté Supabase, l'enregistrement échoue proprement avec un message dédié demandant à ISD de lancer cette mise à jour — rien d'autre n'est perturbé.

C'est explicitement en **mode test** : la clé anon donne un accès public en lecture/écriture au bucket et aux tables (voir la note de sécurité dans `supabase-schema.sql`) — largement suffisant pour un mockup, mais à ne pas considérer comme sécurisé pour de la donnée sensible.

## Bilingue thaï / anglais

L'interface est bilingue (dictionnaire complet dans `js/i18n.js`). Une petite pastille "TH／EN" en haut (dans l'écran de choix du rôle, et dans l'en-tête une fois un rôle choisi) permet de basculer la langue d'affichage à tout moment — ce n'est pas un compte, juste une préférence mémorisée sur l'appareil. Par défaut l'app démarre en **thaï** (la majorité des utilisateurs au quai ne lisent pas l'anglais) ; le management peut basculer en anglais en un tap. La date dans l'en-tête suit aussi la convention thaïe en mode thaï (jour de semaine + année bouddhiste, ex. "วันพุธที่ 3 กันยายน 2569"). Tous les textes de l'app (statuts, boutons, formulaires, messages d'erreur) sont traduits ; le nom de marque "MON Inbound" reste inchangé dans les deux langues.

## Design

Refonte complète du visuel : tuiles de statistiques teintées (vert / orange / rouge), cartes et boutons avec relief et animation de pression au tap, bouton d'ajout (FAB) en accent ambre pour bien ressortir. Pensé pour un vrai rendu d'app mobile (viewport correct, pas de "vue PC dézoomée") plutôt qu'un site web responsive générique. Tout est dans `css/app.css`.

### Vraie identité MON (Round 13)

Jusqu'ici l'app utilisait un bleu approximatif et un logo hexagone générique (placeholder), en attendant les vrais éléments. Suite au retour de Khun Badeeson ("mettre les vraies couleurs et le vrai logo de la société"), Theo a transmis le logo officiel et le guide de marque ("MON Groups Corporate Identity", Corporate Design Manual v1.1, sept. 2017). L'app utilise maintenant :

- **Le vrai logo, en entier** : le bandeau bleu du haut affiche maintenant le logo complet de Theo (hexagone + mot "MON"), dans ses **couleurs d'origine**, sans aucun recadrage ni recoloration (`icons/mark-full.png`). Deux itérations avant d'arriver là : un essai avec juste le hexagone recadré a été écarté ("je veux le logo complet") ; un essai en silhouette blanche unie (variante "monochrome blanc" que le guide de marque prescrit pour un fond de couleur) a aussi été écarté, Theo voulant ses couleurs d'origine. Comme le logo écrit déjà "MON" dedans, le texte "MON" qui apparaissait à côté dans le bandeau a été retiré (seul "INBOUND" reste, en sous-titre) pour ne pas le répéter. Pour garder une bonne lisibilité du logo en couleur sur le fond bleu du bandeau, il repose sur une petite carte blanche arrondie (`.mark-badge` dans `css/app.css`) plutôt que directement sur le dégradé bleu. Les icônes PWA (`icons/icon-512.png`, `icons/icon-192.png`, `icons/favicon.png`) restent, elles, juste le hexagone (plus adapté à une icône carrée) régénéré à partir du même fichier.
- **Les vraies couleurs officielles**, reprises telles quelles depuis la section "Corporate Colours" du guide :
  - Bleu 1 `#006EAF` (bleu principal/interactif → `--brand`)
  - Bleu 2 `#4EB2E5` (bleu clair du guide → `--brand` en mode sombre)
  - Bleu 3 `#004990` (déjà utilisé pour le bandeau depuis longtemps → `--brand-surface`, confirmé exact)
  - Rouge officiel `#D31A2B` → `--bad`
  - Orange secondaire `#F39200` → `--accent` (bouton FAB), une teinte plus soutenue → `--warn`
  - Vert secondaire `#008D36` → `--good`
  - Les variantes `*-ink`/`*-soft` (texte sur couleur, fonds de badge) sont des teintes/nuances dérivées de ces couleurs officielles, calculées pour garder exactement les mêmes ratios de mélange que l'ancienne palette (calcul, pas à l'œil) — le guide ne les définit pas lui-même.

Tout est documenté en commentaire en tête de `css/app.css` (bloc "brand palette (Round 13)") pour qu'ISD retrouve facilement la source de chaque couleur si le guide de marque évolue.

## Autres fonctionnalités

- **Installable sur l'écran d'accueil (PWA)** : `manifest.webmanifest` + les icônes dans `icons/` — sur mobile, le navigateur propose "Ajouter à l'écran d'accueil".
- **Retour vibratoire** : léger vibreur au tap sur Start/Finish (`js/photoUtils.js`, fonction `buzz()`).
- **Nouvelle tentative en cas d'échec réseau** : si l'enregistrement échoue (coupure réseau, etc.), un bouton "Retry" apparaît dans le message d'erreur et relance exactement la même action.
- **Protection contre les doubles actions simultanées** : si deux personnes agissent sur le même camion en même temps (ex. deux chauffeurs tapent "Start" en même temps), la deuxième action est refusée côté Supabase (mise à jour conditionnelle : "ne modifie que si l'état n'a pas changé entre-temps") et l'app se resynchronise automatiquement plutôt que d'écraser l'état.
- **Rafraîchissement au retour sur l'app** : quand le téléphone se réveille ou qu'on revient sur l'onglet, les données se resynchronisent avec Supabase automatiquement.
- **Rafraîchissement en douceur** : `render()` reconstruit tout le HTML à chaque cycle (voir plus bas) — sans précaution, ça remettait le scroll en haut de la page à chaque rafraîchissement périodique (~15s), ce qui donnait une impression de "saut violent" en lisant la liste. La position de scroll est maintenant conservée à travers chaque rafraîchissement. Par ailleurs, tant qu'une fiche camion est ouverte (n'importe quel rôle, n'importe quel statut — même un camion "terminé" qu'on est juste en train de consulter), le rafraîchissement périodique est mis en pause pour ne pas fermer une section dépliée ("Lots on this truck", "Toutes les données du fichier source") ni interrompre la lecture ; il reprend dès la fermeture de la fiche.
- **Bandeau bleu qui respecte l'encoche/barre de statut du téléphone** : quand l'app est installée sur l'écran d'accueil (`manifest.webmanifest`, `"display": "standalone"`), elle prend tout l'écran y compris la zone de la barre de statut — sans précaution, le contenu du bandeau bleu du haut (nom, horloge, date) se retrouvait collé sous/derrière l'heure et les icônes du téléphone. `css/app.css` (`.topbar`) ajoute maintenant `env(safe-area-inset-top)` à son padding du haut pour que son propre contenu commence toujours après cette zone, quel que soit le téléphone (ne change rien sur un appareil sans encoche/barre superposée, où `env()` vaut 0).
- **Heure prévue toujours visible sur la carte** : une fois un camion "en retard", la pastille de statut affiche les minutes de retard à la place de l'heure — l'heure prévue (ETA) reste donc affichée séparément sur la carte, pour ne jamais la perdre de vue même très en retard.
- **Navigation par jour élargie (Admin, Round 13/15)** : en plus des trois onglets rapides Hier / Aujourd'hui / Demain, deux flèches "◀"/"▶" de part et d'autre avancent ou reculent d'**un jour à chaque clic**, jusqu'à 5 jours de chaque côté d'aujourd'hui au total (`MAX_DAY_OFFSET` dans `js/config.js`, comme `MAX_PHOTOS_PER_TRUCK`, seul endroit à changer si cette plage doit être élargie) — la première version sautait directement à ±5 d'un coup, ce qui ne permettait pas d'atteindre les jours intermédiaires ; corrigé au Round 15. Une fois sur un jour hors Hier/Aujourd'hui/Demain, aucun des trois onglets rapides n'est mis en avant et une petite pastille affiche la date exacte consultée (ex. "12/09") pour ne jamais perdre le fil. Ne concerne que l'Admin — un chauffeur MHE reste toujours sur "Aujourd'hui", comme avant.
- **Bouton "+" toujours accessible et bien placé (Round 15)** : le bouton d'ajout (FAB, orange) restait accroché au bas de la page entière plutôt qu'au bas de l'écran visible — avec beaucoup de camions dans la liste, il fallait faire défiler jusqu'en bas de tout pour l'atteindre. Il reste maintenant fixé au coin bas-droit de l'écran, visible et cliquable à tout instant du scroll. Premier correctif livré avec un ajustement pour "recentrer" le bouton sur grand écran (en supposant que l'app s'affiche dans une colonne étroite centrée sur desktop) — sauf que cette colonne centrée n'a en fait jamais existé dans le HTML réellement généré (règle CSS orpheline, jamais appliquée), donc sur le web le bouton se retrouvait décalé vers le milieu de l'écran au lieu du bord droit réel. Corrigé une seconde fois : le bouton colle maintenant au vrai bord droit de la fenêtre, sur mobile comme sur desktop.
- **Fiche camion en plein écran (Round 15)** : ouvrir un camion (ou tout autre écran : nouveau camion, import, PIN, nom) prend maintenant tout l'écran avec une croix "✕" pour fermer, au lieu d'un panneau partiel qui laissait deviner la liste derrière. Rendu plus net et plus "app pro" sur mobile.
- **File d'attente hors-ligne (Round 16)** : jusqu'ici, une action (Start/Finish/Reopen/Cancel, saisie d'ETA, remarque de dommage, ajout/suppression de camion) qui échouait par manque de réseau affichait juste un bouton "Retry" à retaper manuellement. Une vraie coupure réseau (pas seulement une erreur serveur) met maintenant l'action en attente automatiquement — elle est gardée sur l'appareil (`localStorage`, survit à une fermeture d'app ou un verrouillage du téléphone) et rejouée toute seule dès que le réseau revient (ou au prochain rafraîchissement périodique), sans repasser par l'utilisateur. Un badge orange "N pending" apparaît à côté du point de synchro tant que des actions attendent d'être envoyées, et disparaît une fois rejouées (avec un petit message de confirmation). Les photos ne sont volontairement pas concernées par cette file d'attente (fichiers trop volumineux pour `localStorage`) — un envoi de photo en échec garde son comportement "Retry" existant. Toute la logique est dans `js/offlineQueue.js`.
- **Recherche + filtre "en retard" (Round 17)** : une barre de recherche est apparue entre les tuiles de KPI et la liste — elle filtre en direct (à chaque frappe) par PO, référence, transporteur ou plant, en plus d'un bouton "⏰ En retard" qui, activé, ne montre que les camions en retard/urgents du jour affiché. Les deux se combinent. Purement un filtre d'affichage : les tuiles de KPI et les onglets Hier/Aujourd'hui/Demain continuent de compter tous les camions du jour, peu importe ce qui est tapé dans la recherche. Devient utile dès qu'un jour a beaucoup de camions.
- **Alerte visuelle "bientôt" avant le retard (Round 17)** : un camion encore "programmé" (pas encore en retard, pas encore démarré) dont l'ETA tombe dans les 15 prochaines minutes (`DUE_SOON_MIN` dans `js/config.js`) affiche maintenant une pastille "⏰" ambre au lieu de la pastille bleue habituelle — un signal proactif pour repérer un retard qui approche avant qu'il ne devienne un vrai "en retard", plutôt que de le découvrir après coup. Purement visuel (voir `isDueSoon()` dans `js/status.js`) : ça ne change ni le statut réel du camion, ni les compteurs de KPI, ni l'ordre de tri de la liste.
- **Suppression avec délai d'annulation (Round 17)** : supprimer un camion (bouton Admin, après le double-tap de confirmation existant) ne l'efface plus instantanément et définitivement. Le camion disparaît immédiatement de la liste et des KPI, mais un toast "Annuler" reste affiché pendant 5 secondes (`UNDO_DELETE_MS` dans `js/config.js`) avant que la suppression ne soit réellement envoyée à Supabase (ou au stockage local) — un filet de sécurité contre un mauvais tap sur un quai chargé, sans nouvelle colonne ni écran "camions archivés" à gérer. Toute la logique est dans `deleteTruck()`/`commitDelete()`/`undoDeleteTruck()` (`js/actions.js`).

## Tests automatisés (Round 16, complétée au Round 17)

Le dossier `tests/` contient une suite Playwright (Python, sans pytest — chaque `tests/test_v2_*.py` est un script autonome, 25 au total) qui mocke entièrement les appels Supabase et fait tourner l'app dans un vrai Chromium pour vérifier son comportement de bout en bout (import, photos, offline, reporting, navigation par jour, recherche/filtre, suppression avec annulation, etc.). Elle tourne automatiquement sur chaque `git push`/pull request via `.github/workflows/test.yml` (GitHub Actions) — pensé pour rattraper une régression visuelle ou fonctionnelle (comme le bug du bouton "+" desktop du Round 15, découvert par Theo en production plutôt qu'avant mise en ligne) avant qu'elle n'atteigne un déploiement.

Pour la lancer en local :
```bash
pip install -r tests/requirements.txt
playwright install --with-deps chromium
python3 -m http.server 8934 &      # sert le repo en local (les modules ES ne chargent pas en file://)
bash tests/run_all.sh
```

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
- **`js/offlineQueue.js`** (Round 16) : file d'attente d'actions hors-ligne — descripteurs JSON persistés dans `localStorage`, rejoués séquentiellement via les mêmes fonctions `sbPatchTruckConditional()`/`sbCreateTruck()`/`sbDeleteTruck()` que les appels en direct (`js/actions.js` passe un `queueDescriptor` à `runBackendCall()`), donc toute la logique de conflit existante s'applique de la même façon en rejeu. `js/api.js` distingue un échec `fetch()` (vraie coupure réseau, `err.networkFailure = true`, mis en file) d'une réponse HTTP d'erreur (serveur joignable mais refuse, comportement "Retry" inchangé).
- **`js/reporting.js`** (Round 16, export CSV ajouté au Round 17) : écran de synthèse Admin (📊), requête Supabase à plage de dates explicite (`sbFetchTrucksForReport()` dans `js/api.js`), calculs regroupés dans `computeReportStats()`, et `exportReportCsv()` qui construit le CSV depuis `ui.reportRows` (les mêmes lignes que celles utilisées pour les KPI, gardées en mémoire pour ne pas refaire de requête) et déclenche le téléchargement via un objet URL jetable.
- **`tests/`** (Round 16, complétée au Round 17) : suite Playwright (voir section "Tests automatisés" plus haut) + `.github/workflows/test.yml` pour la faire tourner en CI sur chaque push/PR.
- **Recherche/filtre/alerte "bientôt"/suppression annulable (Round 17)** : `ui.searchQuery`/`ui.filterLateOnly` (`js/state.js`) filtrent la liste dans `listHtml()` (`js/render.js`), jamais les KPI ; `isDueSoon()` (`js/status.js`) est une fonction additive à `derive()`, jamais un remplacement (aucun code existant qui lit le statut dérivé n'a besoin de savoir qu'elle existe) ; la suppression passe maintenant par `ui.pendingDeleteId`/`ui.pendingDeleteLabel` (`js/state.js`) le temps du délai d'annulation, voir `deleteTruck()`/`commitDelete()`/`undoDeleteTruck()` dans `js/actions.js`.
- **Le champ de recherche garde le focus à travers `render()` (Round 17)** : comme `render()` reconstruit tout `#app` à chaque frappe pour filtrer la liste en direct, un élément focus perdrait normalement le focus et la position du curseur à chaque caractère tapé. `render()` (`js/render.js`) capture maintenant l'élément actif (id + sélection) avant de reconstruire le HTML et les restaure juste après — même principe que la préservation du scroll (Round 11), appliqué ici à n'importe quel `<input>`/`<textarea>` qui a un `id` et le focus au moment du render.
- **CSS orpheline à connaître (Round 15)** : `css/app.css` définit une règle `.shell{max-width:480px; margin:0 auto; ...}` qui n'est appliquée à aucun élément — `render()` (`js/render.js`) construit le contenu de `#app` directement, sans l'envelopper dans un `<div class="shell">`. Sur mobile ça ne se voit jamais (l'écran est de toute façon étroit), mais sur un grand écran desktop, l'app remplit toute la largeur de la fenêtre plutôt que de s'afficher dans une colonne étroite centrée façon "carte mobile". Si quelqu'un veut un jour ce rendu "carte centrée" sur desktop, il suffirait d'envelopper le HTML généré par `render()` dans `<div class="shell">...</div>` — la règle CSS est déjà prête et attend juste d'être branchée.
