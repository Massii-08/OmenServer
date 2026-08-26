// frontend/js/paper_module.js
// Vue dédiée « Paper Trading » : simulateur de trading actif en argent fictif
// (CHF) sur des cours réels, doublé d'un coach à mémoire persistante.
//
// Le backend est figé par le contrat §9 de
// docs/superpowers/specs/2026-08-24-paper-trading-design.md (préfixe /api/paper).
// Ce module ne fait que LIRE ce contrat : il ne décide rien, il n'invente aucun
// chiffre, et il affiche les avertissements du backend sans jamais bloquer.
//
// Contraintes du dépôt respectées ici :
//   - vanilla JS, zéro dépendance, zéro CDN (composants Bento + inline minimal) ;
//   - concaténation de chaînes en quotes simples, JAMAIS de template literal :
//     un backtick perdu dans du HTML embarqué tue le module entier (piège #28) ;
//   - toute donnée dynamique passe par esc() avant innerHTML (audit 2026-06-21) ;
//   - un bouton porteur de DONNÉES passe par data-* + délégation, jamais par un
//     onclick avec une valeur interpolée ;
//   - tout texte d'interface passe par Lang.t() — aucune chaîne en dur ;
//   - appels API uniquement via Auth.apiCall() ;
//   - couleurs par TOKENS uniquement (le mode clair « Givre » suit tout seul).
//
// Lecture : nombres en CHF au format suisse (10’000.00), R multiple coloré
// (accent = positif, danger = négatif) — c'est le R qui apprend le risque, pas
// le pourcentage de gain.
const PaperModule = {
    // ------------------------------------------------------------------ état
    _container: null,
    _host: null,               // élément qui porte les écouteurs délégués
    _onClick: null,
    _onInput: null,
    _refresh: null,            // tick + portefeuille toutes les 60 s
    _searchTimer: null,        // anti-rebond 400 ms de la recherche

    _tab: 'portfolio',
    _p: null,                  // portefeuille normalisé
    _news: null,               // veille des positions : [{ts,symbol,title,link,sentiment}]
    _coach: null,              // {biases, summary}
    _notes: null,              // carnet PERSONNEL : [{name,size,modified}]
    _community: null,          // carnets des autres : {users:[{user,notes:[...]}]}
    _noteOwner: null,          // carnet affiche (null = le mien)
    _contentLang: null,        // langue du contenu backend actuellement en cache
    _ideas: null,              // {text, ideas:[{ticker,direction,horizon_days,thesis,tracked}]}
    _watch: null,              // favoris : {symbols:[{symbol,name,currency,added_at}]}
    _watchQuotes: {},          // cours des favoris (best-effort, un seul appel groupé)
    _analysisPrefill: '',      // symbole poussé vers la fiche d'analyse
    _noteName: null,
    _noteBody: null,
    _lessons: null,
    _lessonId: null,
    _quizResult: null,
    _arena: null,
    _whales: null,            // {managers:[{id,label,cached,quarter}]}
    _whaleId: null,           // gerant selectionne
    _whaleSnap: null,         // instantane 13F du gerant selectionne
    _whaleLoading: false,     // le fetch SEC a froid dure ~10 s
    _whaleEvents: null,       // fil des derniers depots
    _radar: null,             // {stats, hypotheses}
    _board: null,             // plan : {pipeline, learning, scenarios}
    _scenarioText: null,      // texte libre du dernier « Dessiner les chemins »
    _planArchOpen: false,     // les arbres archivés sont repliés par défaut
    _candles: {},             // cache '<symbole>|<periode>' -> {loading,error,data}
    _chartRange: {},          // periode choisie PAR emplacement de graphique
    _chartWanted: [],         // graphiques a charger apres le rendu courant
    _chartBound: [],          // canvases equipes d'ecouteurs (nettoyes au dechargement)
    _onChartResize: null,     // UN seul ecouteur window, retire avec les graphiques
    _posOpen: null,           // position depliee dans la vue Portefeuille
    _analysisSymbol: null,    // symbole de la derniere fiche d'analyse
    _tradeIdx: null,           // journal : trade ouvert en détail
    _postmortem: null,
    _answer: null,             // réponse du coach
    _analysis: null,           // fiche d'analyse
    _results: null,            // résultats de recherche
    _pick: null,               // {symbol,name,exchange,currency}
    _quote: null,              // {price,currency,change_pct,fx_rate_chf}
    _form: {},                 // survit aux re-rendus du corps

    _ideasJournal: null,       // journal daté : {entries:[{id,ts,kind,...}]}
    _journalOpen: {},          // id d'entrée -> texte déplié
    _review: null,             // revue des positions : {text, verdicts:[...]}
    _reviewOpen: false,        // texte complet de la revue déplié
    _alertsMode: null,         // 'calme' | 'tout' (lu au serveur)
    _alertsBusy: false,        // un POST de bascule est en vol
    _symIdeas: {},             // symbole -> {items:[...]} : ce que le coach a DÉJÀ dit
    _symIdeasClosed: {},       // symbole -> la carte a été fermée à la main
    _symTextOpen: {},          // 'symbole|rang' -> thèse dépliée

    // --- Toile « Connexions » -----------------------------------------------
    _graph: null,              // toile affichée : {nodes, edges, truncated, generated_at}
    _graphSymbol: null,        // ancre du mode ego (null = index global)
    _graphPivot: null,         // bosquet déplié (monde / foule / radar), sans requête
    _graphAnchors: [],         // pills : ancres relevées sur la DERNIÈRE toile globale
    _graphLoading: false,
    _graphLayout: null,        // positions calculées pour le canvas courant
    _graphHover: null,         // id du nœud survolé (ou tapé du doigt)
    _graphRaf: 0,              // repeint groupé par requestAnimationFrame
    _graphCounts: {},          // symbole -> nombre de connexions (chip du graphique)
    _graphCanvas: null,        // canvas équipé d'écouteurs (retirés au re-rendu)
    _onGraphResize: null,      // UN seul écouteur window, retiré avec le canvas
    _graphResizeTimer: null,
    // « Quand on ouvre, on voit tout » : un bosquet se lit désormais PAR
    // NIVEAUX — familles, puis sujets, puis dépêches — sur sa liste ENTIÈRE
    // servie par /graph/grove, jamais sur les douze satellites du dessin. Plus
    // aucun « +N autres » sur ce chemin : ce qui n'est pas dessiné est dans la
    // liste dépliée dessous (retour utilisateur du 26/08, capture à l'appui).
    _groveCache: {},           // kind -> {items, total} : lu UNE fois, gardé
    _groveLoading: '',         // kind en cours de lecture ('' = aucune)
    _groveOpen: null,          // liste PLATE ouverte par un agrégat d'arbre de titre
    _drillFam: '',             // bosquet : famille ouverte — une CLÉ, pas un libellé
    _drillTheme: '',           // bosquet : sujet ouvert — une CLÉ, pas un libellé
    _drillSub: '',             // bosquet : sous-sujet ouvert — une CLÉ, pas un libellé

    _fabOpen: false,           // panneau coach flottant ouvert
    _fabQ: '',                 // question en cours de saisie (survit à la fermeture)
    _fabAnswer: null,          // dernier échange {q, a}
    _onKey: null,              // Échap ferme le panneau flottant

    // Registre des appels LLM EN VOL, au niveau du MODULE. Il vivait avant sur
    // le bouton (disabled + libellé) : le corps étant réécrit à chaque re-rendu
    // — changement d'onglet, poll de 60 s —, le bouton porteur de l'état
    // disparaissait et l'attente devenait invisible pendant que la requête,
    // elle, continuait toute seule. Ici l'état survit au DOM ; chaque rendu le
    // RÉAPPLIQUE (_applyBusy) sur les boutons marqués data-paper-busy.
    // Table FERMÉE : une clé absente n'arme rien.
    _busy: {
        ideas: false, scenarios: false, ask: false,
        review: false, postmortem: false, analysis: false, radar: false,
    },

    // Libellé d'attente par clé — le radar a le sien. Défaut : paper.thinking.
    _BUSY_LABEL: { radar: 'paper.radar_thinking' },

    // Onglet propriétaire de chaque réponse + message de bonne arrivée. Quand
    // la réponse tombe alors qu'on regarde AILLEURS, on le dit : le résultat
    // attend dans l'état du module, pas dans un DOM détruit.
    _BUSY_HOME: {
        ideas: ['coach', 'paper.ready_ideas'],
        ask: ['coach', 'paper.ready_answer'],
        analysis: ['coach', 'paper.ready_analysis'],
        postmortem: ['journal', 'paper.ready_postmortem'],
        scenarios: ['plan', 'paper.ready_scenarios'],
        review: ['portfolio', 'paper.ready_review'],
    },

    _mono: 'font-family:var(--font-mono);font-feature-settings:\'tnum\';',

    // Niveau de risque demandé au coach pour ses idées. Le choix est PERSONNEL
    // et persiste d'une visite à l'autre (localStorage), mais la liste reste
    // une WHITELIST FERMÉE : une valeur venue du stockage (que n'importe qui
    // peut éditer dans la console) qui n'y figure pas ne produit ni clé i18n
    // ni classe CSS — on ne concatène jamais une chaîne étrangère dans un nom.
    // « crypto » est un niveau à part entière, pas une nuance du spéculatif :
    // l'analyse y est 100 % crypto (majors comparées entre elles, long/short).
    _LEVELS: ['mesure', 'agressif', 'speculatif', 'crypto'],
    _LEVEL_KEY: 'paper-risk-level',
    _level: 'mesure',

    // Le bilan du radar compte AUSSI les hypothèses qu'il a générées tout seul
    // (« radar »), qui n'est donc pas un niveau proposé à la demande d'idées.
    // Ordre FIXE : un objet JSON n'a pas d'ordre garanti et le lecteur doit
    // retrouver ses niveaux à la même place d'une fois sur l'autre.
    _LEVEL_ORDER: ['mesure', 'agressif', 'speculatif', 'crypto', 'radar'],

    // Nature de l'actif → [clé i18n, classe .badge]. Table FERMÉE elle aussi :
    // « equity » n'a pas de badge (c'est le cas ordinaire, le signaler
    // n'apprendrait rien) et une valeur inconnue non plus. Noter que la valeur
    // backend « forex » porte la clé courte paper.kind_fx : d'où la table
    // plutôt qu'une concaténation 'paper.kind_' + kind.
    _ASSET_KINDS: {
        crypto: ['paper.kind_crypto', 'warn'],
        forex: ['paper.kind_fx', 'info'],
        etf: ['paper.kind_etf', 'muted'],
    },

    // --- Revue, journal, alertes : whitelists FERMÉES ------------------------
    //
    // Même doctrine que _LEVELS et _ASSET_KINDS : rien de ce qui vient du
    // backend ne sert à fabriquer une clé i18n ni un nom de classe par
    // concaténation. Ce qui n'est pas dans la table ne produit rien.

    // Avis du coach sur une position → classe .badge. Un avis inconnu retombe
    // sur « surveiller » : le repli est le conseil le plus neutre, jamais
    // « sortir » — on ne fait pas dire au coach ce qu'il n'a pas dit.
    _STANCES: { garder: 'online', surveiller: 'warn', alleger: 'warn', sortir: 'danger' },

    // Nature d'une entrée du journal des idées. Un genre inconnu n'a pas de
    // badge : l'entrée reste lisible, elle n'est simplement pas étiquetée.
    _JOURNAL_KINDS: { ideas: 'paper.ideas_log_kind_ideas', review: 'paper.ideas_log_kind_review' },

    // Provenance d'un avis déjà rendu sur un titre (pop-up « le coach sur X »).
    _SYM_FROM: {
        radar: 'paper.symideas_from_radar',
        journal: 'paper.symideas_from_journal',
        review: 'paper.symideas_from_review',
    },

    // Régime de notification. « calme » est le défaut et le repli.
    _ALERT_MODES: ['calme', 'tout'],

    // --- Toile « Connexions » : whitelists FERMÉES ---------------------------
    //
    // LA règle de lecture de la vue : **le nœud dit D'OÙ vient l'information,
    // le lien dit CE QU'ELLE RACONTE**. La couleur d'un nœud est donc celle de
    // sa SOURCE (presse, politique, crypto, social, gérants, radar) et rien
    // d'autre ; la couleur d'une arête est celle du jugement porté (positif,
    // négatif, à surveiller). Deux alphabets qui ne se marchent jamais dessus.
    //
    // Table des types de nœud : [clé i18n, token de couleur, famille de source].
    // Un type inconnu ne fabrique NI classe NI clé i18n — il tombe sur une
    // pastille neutre (--text-dim), n'affiche que son libellé brut, et se range
    // dans la famille « other ».
    //
    // Les tokens choisis sont ceux du design system qui ont un pendant CLAIR
    // (--dot-* du mode « Givre », --warning/--orange/--violet/--info redéfinis
    // dans le bloc light) : les deux modes sortent justes sans table parallèle.
    _GNODE: {
        position:     ['paper.gnode_position',   '--accent',      ''],
        watchlist:    ['paper.gnode_watchlist',  '--accent',      ''],
        pipeline:     ['paper.gnode_pipeline',   '--text-muted',  ''],
        news:         ['paper.gnode_news',       '--dot-cyan',    'press'],
        catalyst:     ['paper.gnode_catalyst',   '--dot-cyan',    'press'],
        gov:          ['paper.gnode_gov',        '--warning',     'gov'],
        // Deux familles MONDIALES de plus, qui arrivent dans le bosquet
        // « monde » comme les annonces politiques : la macroéconomie et le
        // climat. Le choix des tokens est raisonné dans _GFAM.
        eco:          ['paper.gnode_eco',        '--dot-violet',  'eco'],
        climat:       ['paper.gnode_climat',     '--dot-green',   'climat'],
        crypto:       ['paper.gnode_crypto',     '--orange',      'crypto'],
        x:            ['paper.gnode_x',          '--dot-magenta', 'social'],
        reddit:       ['paper.gnode_reddit_post', '--dot-magenta', 'social'],
        reddit_trend: ['paper.gnode_reddit',     '--dot-magenta', 'social'],
        whale_move:   ['paper.gnode_whale',      '--violet',      'whale'],
        hypothesis:   ['paper.gnode_hypothesis', '--info',        'radar'],
        context:      ['paper.gnode_context',    '--text-dim',    ''],
        // L'AGRÉGAT n'est pas une information : c'est le COMPTEUR de ce que le
        // serveur a coupé (« +67 autres »). Famille vide À DESSEIN — il ne
        // vient d'aucune source, il ne doit donc pas ajouter de pastille à la
        // légende. Sa couleur d'affichage est celle de son bosquet, estompée ;
        // ce token n'est que le repli quand le bosquet n'a pas de famille.
        aggregate:    ['paper.gnode_aggregate',  '--text-muted',  ''],
        // Le THÈME n'est pas une information non plus : c'est un SUJET, un
        // intercalaire que le serveur pose quand une famille déborde (huit
        // dépêches Trump/Canada sous le même rameau — capture du 26/08).
        // Famille vide À DESSEIN, comme l'agrégat : il ne vient d'aucune
        // source, il prend celle de ses feuilles (qui n'en ont qu'une, le
        // serveur ne groupe que DANS une famille).
        theme:        ['paper.gnode_theme',      '--text-muted',  ''],
    },

    // Les trois types qui portent un titre : ce sont EUX les ancres de la
    // toile (les TRONCS de la forêt), et eux seuls qu'un clic fait basculer en
    // vue rapprochée.
    _GANCHOR: { position: 1, watchlist: 1, pipeline: 1 },

    // Familles de SOURCE : [clé i18n, token]. Une famille est à la fois une
    // pastille de légende et un RAMEAU intermédiaire sur un tronc. X et Reddit
    // partagent la même (social) : ce sont deux robinets du même tonneau.
    //
    // POURQUOI ces deux tokens-là pour « Économie » et « Climat ». Les hues du
    // système sont déjà presque toutes prises : cyan (presse), ambre (politique),
    // orange (crypto), magenta (social), lilas (gérants), bleu (radar). Il ne
    // restait, avec un pendant CLAIR déclaré, que le vert (--dot-green) et
    // l'indigo (--dot-violet) — les alias legacy (--accent-blue/-cyan/-purple/
    // -yellow/-red) tombent tous, EN MODE CLAIR, sur la valeur exacte d'un token
    // sémantique déjà employé ici, donc ils ne distinguent rien. D'où :
    //   climat → --dot-green  (le vert dit « climat » sans légende) ;
    //   eco    → --dot-violet (indigo franc, LOIN de la zone ambre/orange où
    //                          vivent politique et crypto, avec qui l'économie
    //                          partage tous ses écrans).
    // Deux réserves, assumées et écrites pour qu'on ne les redécouvre pas :
    //   - --dot-green vaut --accent quand l'accent est vert (le défaut) ; sans
    //     conséquence ici, un bosquet ne dessine aucune ancre, et une ancre est
    //     un disque nommé de rayon 9+ face à une feuille de 4,5 ;
    //   - --dot-violet frôle --violet (gérants) en mode clair ; les deux ne se
    //     croisent qu'à la légende de l'index, les mouvements de gérant pendant
    //     à un titre et l'économie vivant dans le bosquet « monde ».
    _GFAM: {
        press:  ['paper.gfam_press',  '--dot-cyan'],
        gov:    ['paper.gfam_gov',    '--warning'],
        eco:    ['paper.gfam_eco',    '--dot-violet'],
        climat: ['paper.gfam_climat', '--dot-green'],
        crypto: ['paper.gfam_crypto', '--orange'],
        social: ['paper.gfam_social', '--dot-magenta'],
        whale:  ['paper.gfam_whale',  '--violet'],
        radar:  ['paper.gfam_radar',  '--info'],
        other:  ['paper.gfam_other',  '--text-dim'],
    },

    // Ordre FIXE des rameaux et de la légende (un objet JSON n'a pas d'ordre,
    // et deux rendus doivent donner exactement la même image). Les deux
    // nouvelles familles s'INSÈRENT après la politique — les trois familles du
    // monde se lisent d'affilée — sans déplacer les autres les unes par rapport
    // aux autres.
    _GFAM_ORDER: ['press', 'gov', 'eco', 'climat', 'crypto', 'social', 'whale',
        'radar', 'other'],

    // Sentiment d'une arête → token. Neutre = le trait de la grille : une
    // liaison sans jugement ne doit pas se lire comme un avis. « neutral » est
    // DÉCLARÉ plutôt que laissé au repli des types inconnus : le serveur
    // l'envoie désormais, et un lecteur du code doit voir que ce gris-là est
    // voulu, pas le résultat d'un type qu'on n'a pas su lire.
    _GEDGE: { pos: '--accent', neg: '--danger', watch: '--warning', gov: '--warning',
        neutral: '--border' },

    // Sentiments qui ATTÉNUENT la pastille : la feuille garde la couleur de sa
    // source (une dépêche neutre reste cyan « presse »), mais en retrait — elle
    // est là, elle ne crie pas. Une nouvelle jugée, elle, garde tout son éclat.
    _GSENT_SOFT: { neutral: 1 },

    // Verdict d'une hypothèse → [token de pastille, clé i18n]. Les clés sont
    // celles du radar : le même mot pour la même chose aux deux endroits.
    _GHYP_OUT: {
        hit:     ['--accent',     'paper.radar_outcome_hit'],
        miss:    ['--danger',     'paper.radar_outcome_miss'],
        unclear: ['--text-muted', 'paper.radar_outcome_unclear'],
    },

    // Longueur d'étiquette PAR TYPE de nœud (voir _gLabelMax). Une thèse du
    // radar a droit à plus de place — c'est une phrase, et son bosquet en tient
    // douze au plus. Tout ce qui n'est pas listé tient en trente signes.
    _GLABEL_MAX: { hypothesis: 40, aggregate: 30, theme: 26 },

    // Le fourre-tout d'un regroupement thématique. Le serveur l'envoie nommé en
    // français (« Divers ») comme les pivots et l'agrégat : on le RECONNAÎT par
    // sa clé — whitelist FERMÉE — et on rend le nom de la langue de l'écran.
    _GTHEME_MISC: 'divers',

    // Mécanisme du rapprochement qui se dessine en POINTILLÉS. « issuer » = on
    // a rapproché un nom d'émetteur d'un ticker : c'est le lien le plus
    // incertain de la toile, et ça doit se VOIR sans avoir à cliquer.
    _GEDGE_DASH: { issuer: 1 },

    // Bosquet du serveur -> le « kind » que l'endpoint de LISTE accepte. Whitelist
    // FERMÉE : l'identifiant d'un pivot vient du serveur, on ne le lui renvoie
    // pas tel quel — on le RECONNAÎT, et un identifiant qu'on ne reconnaît pas
    // ne déclenche aucune requête (plutôt qu'un aller-retour pour un 400).
    _GROVE_KIND: { monde: 'monde', foule: 'foule', radar: 'radar' },

    // …et le rôle correspondant, pour NOMMER la liste dans la langue de
    // l'écran : le serveur envoie « Monde », l'écran doit lire « Contexte
    // mondial » / « World context » / « Contesto mondiale ».
    _GROVE_ROLE: { monde: 'world', foule: 'crowd', radar: 'radar' },

    // Verdict d'une hypothèse -> variante de badge. Même whitelist fermée que
    // _GHYP_OUT (qui, lui, donne le libellé) : un code inconnu ne fabrique ni
    // classe ni clé i18n par concaténation.
    _GROVE_OUT_BADGE: { hit: 'online', miss: 'danger', unclear: 'muted' },

    // Longueur d'un titre DANS LA LISTE. Le titre entier reste dans l'attribut
    // « title » : on tronque à l'écran, jamais dans la donnée.
    _GROVE_TITLE_MAX: 90,

    // --- Bosquet PAR NIVEAUX : familles > sujets > sous-sujets > dépêches -----
    //
    // Combien de dépêches sont DESSINÉES au dernier niveau. Le canvas montre le
    // récent, la LISTE dépliée dessous porte tout : c'est ce partage qui
    // remplace l'anneau « +N autres », lequel annonçait une masse et la cachait.
    _GDRILL_LEAVES: 18,

    // --- L'aile de CONVERGENCE ------------------------------------------------
    //
    // Au dernier niveau, les dépêches de la famille ouverte s'éventaillent à
    // droite du sujet — et celles des AUTRES familles qui parlent du MÊME sujet
    // arrivent du BORD DROIT du cadre, étiquettes à gauche, et convergent sur
    // lui. C'est la corroboration RENDUE VISIBLE : quand la presse et X disent
    // la même chose, le sujet devient un point où deux mondes se rejoignent
    // (demande utilisateur du 26/08 : « les infos de X/Reddit se relient depuis
    // la droite »).
    //
    // Combien en sont dessinées, et à quelle abscisse (repère ABSTRAIT, ramené
    // dans le cadre par _graphFit — donc « bord droit » quelle que soit la
    // taille de l'écran).
    // L'abscisse est CALEE pour que l'homothetie de _graphFit pose l'aile juste
    // devant la marge de droite : plus courte, elle laissait deux cents pixels
    // de vide au bord et l'aile ne se lisait plus comme un bord (mesure a
    // l'ecran, canvas 956 x 520).
    _GDRILL_CROSS: 12,
    _GDRILL_CROSS_X: 880,
    _GDRILL_CROSS_GAP: 34,

    // Longueur des étiquettes QUAND les deux ailes coexistent : celles de
    // l'éventail courent vers la droite, celles de l'aile opposée vers la
    // gauche, et sans ces deux plafonds les deux colonnes de texte se
    // rejoindraient au milieu du cadre (mesuré : 30 signes de chaque côté se
    // chevauchent dès 900 px de large).
    _GDRILL_FAN_LABEL: 22,
    _GDRILL_CROSS_LABEL: 20,

    // Types qu'un bosquet ne RANGE pas : ce sont des pièces de la toile, pas des
    // informations. Whitelist FERMÉE — si le serveur en glisse un dans la liste
    // (l'agrégat, par exemple), il est simplement IGNORÉ ici plutôt que de
    // fabriquer une famille « Autre » qui ne veut rien dire.
    _GDRILL_SKIP: { aggregate: 1, theme: 1, context: 1 },

    // Le chevron du fil d'Ariane, en échappement Unicode À DESSEIN — même raison
    // que _GTREND_UP : écrit en clair il tomberait au premier balayage de formes
    // du dépôt (piège #17).
    _GCRUMB_SEP: '\u203A',

    // La flèche de tendance, en échappement Unicode À DESSEIN : écrite en clair
    // elle tomberait au premier balayage d'emojis du dépôt (piège #17).
    _GTREND_UP: '\u2191',

    // PLUS AUCUN plafond de dessin côté client. La vue globale ne dessine que
    // des troncs et trois cartes ; un arbre déplié ne concerne qu'un sujet, dont
    // le serveur borne déjà le cortège (douze items par bosquet + un agrégat).
    // Un plafond ici mutilerait surtout les COMPTEURS, qui se lisent sur la
    // totalité des arêtes — c'est le serveur, et lui seul, qui dit avoir rogné.

    // --- Plan : whitelists FERMÉES ------------------------------------------
    //
    // Même doctrine que _LEVELS et _ASSET_KINDS : un état, une probabilité ou
    // un code d'étape venu du backend ne sert JAMAIS à fabriquer une clé i18n
    // ni un nom de classe par concaténation. Ce qui n'est pas dans la table ne
    // produit rien — pas de badge inventé, pas de clé fantôme à l'écran.

    // Ordre FIXE des colonnes du pipeline : c'est le trajet d'une idée, de
    // « je regarde » jusqu'à « c'est fini ». Un objet JSON n'a pas d'ordre.
    _PIPE_STAGES: ['etude', 'pret', 'ordre', 'position', 'clos'],

    // Les DEUX seules colonnes que la main peut choisir. Les trois autres sont
    // dérivées du portefeuille (un ordre passé, une position ouverte, un trade
    // clos) : les déplacer à la main ferait mentir le board.
    _PIPE_MANUAL: { etude: 1, pret: 1 },

    // Le pas suivant d'une colonne manuelle (etude ↔ pret), et rien d'autre.
    _PIPE_NEXT: { etude: 'pret', pret: 'etude' },

    // Probabilité d'une branche → classe .badge. « faible » reste neutre :
    // la teinte monte avec la vraisemblance, elle ne juge pas la branche.
    _SCN_PROBS: { faible: '', moyenne: 'warn', haute: 'online' },

    // Sort d'une branche. « open » n'a pas de badge : ce sont ses deux boutons
    // qui l'affichent — un pari encore ouvert n'a rien à annoncer.
    _SCN_STATUS: { happened: 'online', invalidated: 'danger' },

    // Étapes franchies connues du coach (backend : MILESTONE_DEFS). Un code
    // inconnu s'affiche BRUT plutôt que de disparaître — on ne cache jamais un
    // acquis parce qu'on ne sait pas le traduire.
    _MILESTONES: {
        first_10_trades: 1,
        first_positive_expectancy: 1,
        survived_20pct_drawdown: 1,
        fifty_trades: 1,
    },

    // ------------------------------------------------------------ cycle de vie

    async render(container) {
        this.unload();                       // coupe tout timer d'un rendu précédent
        this._syncContentLang();             // langue changée ? le contenu périmé part
        this._loadLevel();                   // le niveau a pu être choisi dans un autre onglet
        this._container = container;
        if (!container) return;
        // Rechargement de page : on rouvre l'écran là où il était (onglet,
        // période du graphique) AVANT le premier rendu, et on note le titre à
        // re-sélectionner une fois la coquille en place.
        const pending = this._restoreUi();
        container.innerHTML = this._shell();
        this._bind();
        this._renderTabs();
        await this._tickAndLoad();
        this._renderBody();
        // L'onglet ouvert redemande SES données. Indispensable après un
        // changement de langue : _syncContentLang vient de jeter le contenu
        // périmé, et sans cet appel la vue resterait sur « Chargement… » —
        // _loadTab ne tourne sinon qu'au clic sur un onglet. (Vu à l'écran.)
        this._loadTab();
        this._paintFab();
        // Le titre qu'on étudiait revient par le MÊME chemin qu'un clic sur
        // « Choisir » : cours, graphique et brouillon du formulaire compris.
        if (pending) this.pick(pending, '', '', '');
        // Un seul rendez-vous périodique : passer les ordres en attente puis
        // relire le portefeuille. Il ne réécrit le corps que si l'onglet
        // Portefeuille est affiché — sinon il effacerait un formulaire en cours
        // de saisie (leçon du sélecteur Market Pulse).
        this._refresh = setInterval(() => this._periodic(), 60000);
    },

    unload() {
        if (this._refresh) { clearInterval(this._refresh); this._refresh = null; }
        if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
        // Un brouillon en attente d'écriture part sur le disque MAINTENANT :
        // quitter la vue ne doit pas coûter les 300 dernières millisecondes.
        if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; this._saveDraft(); }
        this._disposeCharts();
        this._disposeGraph();
        // Le coach flottant n'existe QUE dans ce module : il part avec lui.
        this._removeFab();
        if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
        if (this._host && this._onClick) this._host.removeEventListener('click', this._onClick);
        if (this._host && this._onInput) {
            this._host.removeEventListener('input', this._onInput);
            this._host.removeEventListener('change', this._onInput);
        }
        this._host = null;
        this._onClick = null;
        this._onInput = null;
    },

    // Un seul écouteur délégué par type, POSÉ SUR LE CONTENEUR (qui survit aux
    // réécritures de innerHTML) et RETIRÉ au déchargement — sinon chaque
    // aller-retour vers l'onglet en empilerait un de plus.
    _bind() {
        const host = this._container;
        if (!host) return;
        this._host = host;
        this._onClick = (ev) => this._click(ev);
        this._onInput = (ev) => this._input(ev);
        host.addEventListener('click', this._onClick);
        host.addEventListener('input', this._onInput);
        host.addEventListener('change', this._onInput);
        // Échap ferme le panneau flottant. L'écouteur vit sur le document (le
        // panneau n'a pas le focus quand on lit la réponse) et part au déchargement.
        this._onKey = (ev) => {
            if (ev && ev.key === 'Escape' && this._fabOpen) { this._fabOpen = false; this._paintFab(); }
        };
        document.addEventListener('keydown', this._onKey);
    },

    // --------------------------------------------------------------- outillage

    _toast(kind, msg) {
        if (typeof Toast === 'undefined' || !Toast[kind]) return;
        Toast[kind](msg);
    },

    // Nombre → null quand ce n'est pas un nombre exploitable (le backend peut
    // rendre null, '' ou un champ absent : on ne suppose jamais sa présence).
    _n(v) {
        const n = Number(v);
        if (v === null || v === undefined || v === '' || !isFinite(n)) return null;
        return n;
    },

    // Premier champ non nul parmi des alias (le contrat fige les concepts, pas
    // toujours le nom exact du champ : on lit tolérant, on n'invente rien).
    _pickField(obj, keys) {
        if (!obj || typeof obj !== 'object') return null;
        for (let i = 0; i < keys.length; i++) {
            const v = obj[keys[i]];
            if (v !== null && v !== undefined && v !== '') return v;
        }
        return null;
    },

    // 10000 -> « 10’000.00 » (séparateur de milliers suisse : apostrophe typographique)
    _num(v, dec) {
        const n = this._n(v);
        if (n === null) return '—';
        const d = (dec === null || dec === undefined) ? 2 : dec;
        const parts = Math.abs(n).toFixed(d).split('.');
        const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '’');
        return (n < 0 ? '-' : '') + int + (parts[1] ? '.' + parts[1] : '');
    },

    _signed(v, dec, unit) {
        const n = this._n(v);
        if (n === null) return '—';
        return (n > 0 ? '+' : '') + this._num(n, dec) + (unit || '');
    },

    _chf(v, dec) {
        const s = this._num(v, dec);
        return s === '—' ? s : (s + ' CHF');
    },

    _signedChf(v, dec) {
        const s = this._signed(v, dec, '');
        return s === '—' ? s : (s + ' CHF');
    },

    _money(v, currency, dec) {
        const s = this._num(v, dec === undefined ? 2 : dec);
        if (s === '—') return s;
        return currency ? (s + ' ' + String(currency)) : s;
    },

    _color(dir) {
        const n = this._n(dir);
        if (n === null || n === 0) return 'var(--text-muted)';
        return n > 0 ? 'var(--accent)' : 'var(--danger)';
    },

    // Accepte un ISO (« 2026-08-24T09:12:00 ») comme un epoch en secondes.
    _toDate(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        if (isFinite(n) && typeof v !== 'string') return new Date(n * 1000);
        if (isFinite(n) && /^\d+$/.test(String(v))) return new Date(n * 1000);
        const d = new Date(String(v));
        return isNaN(d.getTime()) ? null : d;
    },

    _date(v) {
        const d = this._toDate(v);
        if (!d) return '—';
        const p = (x) => (x < 10 ? '0' : '') + x;
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
    },

    _dateTime(v) {
        const d = this._toDate(v);
        if (!d) return '—';
        const p = (x) => (x < 10 ? '0' : '') + x;
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() +
            ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },

    // Une clé i18n absente est rendue TELLE QUELLE par Lang.t (elle est donc
    // « truthy ») : le || ne peut pas servir de repli (piège #12).
    _label(key, fallback) {
        const v = Lang.t(key);
        return (String(v).indexOf(key) === 0) ? String(fallback == null ? '' : fallback) : v;
    },

    _sideLabel(side) {
        const s = String(side || '').toLowerCase();
        return this._label('paper.side_' + s, side);
    },

    _kindLabel(kind) {
        const k = String(kind || '').toLowerCase();
        return this._label('paper.kind_' + k, kind);
    },

    _biasLabel(code) {
        const c = String(code || '');
        return this._label('paper.bias_' + c, c);
    },

    // --- Niveau de risque des idées -----------------------------------------

    _isLevel(v) { return this._LEVELS.indexOf(String(v == null ? '' : v)) >= 0; },

    // Le niveau EFFECTIF, toujours valide. Une valeur douteuse retombe sur
    // « mesuré » : le repli est le niveau le plus prudent, jamais le plus vif.
    _riskLevel() { return this._isLevel(this._level) ? this._level : 'mesure'; },

    // Relu à CHAQUE rendu (le choix a pu être fait dans un autre onglet du
    // navigateur). Un stockage indisponible — Safari en navigation privée,
    // cookies refusés — ne doit jamais casser la vue : d'où le try/catch.
    _loadLevel() {
        let v = null;
        try { v = localStorage.getItem(this._LEVEL_KEY); } catch (e) { v = null; }
        if (this._isLevel(v)) this._level = String(v);
        else if (!this._isLevel(this._level)) this._level = 'mesure';
        return this._level;
    },

    setLevel(v) {
        if (!this._isLevel(v)) return;              // rien de forgé n'entre ici
        this._level = String(v);
        // L'écriture peut être refusée : le choix vaut alors pour la session,
        // ce qui est très bien — on ne perd que la mémoire, pas la fonction.
        try { localStorage.setItem(this._LEVEL_KEY, this._level); } catch (e) { /* sans mémoire */ }
        if (this._tab === 'coach') this._renderBody();
    },

    // --- Mémoire d'écran : l'onglet, le titre choisi, le brouillon ----------
    //
    // Recharger la page pour voir si la courbe a bougé refermait le titre en
    // cours d'étude et effaçait la thèse à moitié écrite (signalé à l'écran).
    // L'état d'écran vit donc dans localStorage, et le brouillon de l'ordre est
    // rangé PAR TITRE — passer de l'un à l'autre ne mélange pas deux réflexions.
    // Un stockage indisponible (navigation privée, cookies refusés) ne casse
    // rien : on perd la mémoire, jamais la fonction.

    _UI_KEY: 'paper-ui-state',
    _DRAFT_PREFIX: 'paper-draft-',

    // Champs du brouillon : liste FERMÉE. Rien d'autre n'est ni écrit ni relu —
    // un stockage est éditable à la main, il n'a pas à décider de ce qui existe.
    _DRAFT_FIELDS: ['side', 'kind', 'qty', 'limit_price', 'stop_price',
        'stop_loss', 'target', 'thesis', 'fee_profile'],

    // Identifiants des champs de l'ordre → sauvegarde du brouillon à la frappe.
    _FORM_IDS: {
        'paper-side': 1, 'paper-kind': 1, 'paper-qty': 1, 'paper-limit': 1,
        'paper-stop': 1, 'paper-sl': 1, 'paper-target': 1, 'paper-thesis': 1,
        'paper-feeprofile': 1,
    },

    _draftTimer: null,

    _readStore(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    _writeStore(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* sans mémoire */ } },
    _dropStore(key) { try { localStorage.removeItem(key); } catch (e) { /* sans mémoire */ } },

    _readJson(key) {
        const raw = this._readStore(key);
        if (!raw) return null;
        let d = null;
        try { d = JSON.parse(raw); } catch (e) { d = null; }
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
    },

    _isTab(v) {
        const t = String(v == null ? '' : v);
        const defs = this._tabDefs();
        for (let i = 0; i < defs.length; i++) { if (defs[i][0] === t) return true; }
        return false;
    },

    _isChartRange(v) {
        const r = String(v == null ? '' : v);
        for (let i = 0; i < this._CHART_RANGES.length; i++) {
            if (this._CHART_RANGES[i][0] === r) return true;
        }
        return false;
    },

    _saveUi() {
        const st = { tab: this._tab };
        if (this._pick && this._pick.symbol) st.symbol = String(this._pick.symbol);
        const per = this._chartRange['trade'];
        if (per) st.chartPeriod = String(per);
        this._writeStore(this._UI_KEY, JSON.stringify(st));
    },

    // Rend le symbole à re-sélectionner (ou null). L'onglet et la période sont
    // posés tout de suite ; la sélection, elle, demande un aller-retour réseau
    // et se fait donc APRÈS le premier rendu — l'écran n'attend pas.
    _restoreUi() {
        const st = this._readJson(this._UI_KEY);
        if (!st) return null;
        if (this._isTab(st.tab)) this._tab = String(st.tab);
        if (this._isChartRange(st.chartPeriod)) this._chartRange['trade'] = String(st.chartPeriod);
        const sym = (st.symbol === null || st.symbol === undefined) ? '' : String(st.symbol);
        return (sym && !this._pick) ? sym : null;
    },

    _draftKey(symbol) { return this._DRAFT_PREFIX + String(symbol || ''); },

    _saveDraft() {
        if (!this._pick || !this._pick.symbol) return;
        const out = {};
        this._DRAFT_FIELDS.forEach((k) => {
            const v = this._form[k];
            if (v !== undefined && v !== null && String(v) !== '') out[k] = String(v);
        });
        this._writeStore(this._draftKey(this._pick.symbol), JSON.stringify(out));
    },

    // Anti-rebond : on n'écrit pas une fois par caractère tapé dans la thèse.
    _queueDraft() {
        if (this._draftTimer) clearTimeout(this._draftTimer);
        this._draftTimer = setTimeout(() => { this._draftTimer = null; this._saveDraft(); }, 300);
    },

    _loadDraft(symbol) {
        const d = this._readJson(this._draftKey(symbol));
        if (!d) return;
        this._DRAFT_FIELDS.forEach((k) => {
            const v = d[k];
            if (v !== undefined && v !== null) this._form[k] = String(v);
        });
    },

    _dropDraft(symbol) {
        if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
        this._dropStore(this._draftKey(symbol));
    },

    // Badge de nature d'actif. Rend '' pour « equity » (le cas ordinaire) et
    // pour tout ce qui n'est pas dans la table — hasOwnProperty écarte au
    // passage les clés héritées du prototype (« constructor », « toString »…).
    _kindBadge(kind) {
        const k = String(kind == null ? '' : kind).toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(this._ASSET_KINDS, k)) return '';
        const d = this._ASSET_KINDS[k];
        return '<span class="badge ' + d[1] + '">' + esc(Lang.t(d[0])) + '</span>';
    },

    // La langue de l'interface pilote aussi le CONTENU rendu par le backend
    // (leçons, quiz, défis, coach). Repli fr côté serveur si indisponible.
    _lang() {
        try {
            const l = (typeof Lang !== 'undefined' && Lang.current) ? String(Lang.current) : 'fr';
            return (l === 'fr' || l === 'en' || l === 'it') ? l : 'fr';
        } catch (e) { return 'fr'; }
    },

    _withLang(url) {
        const u = String(url || '');
        return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'lang=' + encodeURIComponent(this._lang());
    },

    // Changer de langue passe par Lang.set, qui re-navigue donc re-rend ce
    // module : c'est ICI qu'on jette le contenu chargé dans l'ancienne langue.
    // Le rechargement se fait au prochain rendu de l'onglet concerné — pas de
    // re-fetch à chaud de tout, et l'utilisateur ne voit jamais de texte périmé.
    _syncContentLang() {
        const l = this._lang();
        if (this._contentLang === l) return;
        this._contentLang = l;
        this._lessons = null;
        this._arena = null;
        this._coach = null;
        this._quizResult = null;
        this._answer = null;
        this._analysis = null;
        this._postmortem = null;
        this._ideas = null;
        // Le plan porte du texte écrit par le coach (titres et contextes des
        // arbres) : il est périmé lui aussi dès que la langue change.
        this._board = null;
        this._scenarioText = null;
        // Journal, revue, avis par titre et dernier échange flottant portent du
        // texte écrit par le coach dans l'ANCIENNE langue : périmés eux aussi.
        this._ideasJournal = null;
        this._review = null;
        this._symIdeas = {};
        this._fabAnswer = null;
    },

    // Un href ne part JAMAIS dans le DOM sans être vérifié : seuls http(s)
    // passent (une URL vient du flux de presse, donc de l'extérieur).
    _safeUrl(u) {
        const s = String(u == null ? '' : u);
        return /^https?:\/\//i.test(s) ? s : '';
    },

    async _detail(r) {
        if (!r) return Lang.t('paper.error');
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        const msg = d && (d.detail || d.message || d.error);
        return msg ? String(msg) : (Lang.t('paper.error') + ' (' + r.status + ')');
    },

    async _get(url) {
        let r = null;
        try { r = await Auth.apiCall(url); } catch (e) { r = null; }
        if (!r || !r.ok) return null;
        try { return await r.json(); } catch (e) { return null; }
    },

    // ------------------------------------------------------------- coquille

    _shell() {
        return '' +
        '<div class="card" style="margin-bottom:14px;">' +
          // .b-head / .b-icon / .b-name-wrap sont scopés à .bot-card-bento dans
          // style.css : hors carte-bot ils ne posent AUCUNE mise en page. On
          // aligne donc en flex inline ; .b-ticker, lui, est bien global.
          '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<span class="b-ticker">SIM</span>' +
            '<div>' +
              '<div style="font-size:17px;font-weight:600;">' + esc(Lang.t('paper.title')) + '</div>' +
              '<div style="font-size:13px;color:var(--text-muted);">' + esc(Lang.t('paper.subtitle')) + '</div>' +
            '</div>' +
            '<span class="badge" id="paper-feebadge" style="margin-left:auto;"></span>' +
          '</div>' +
          '<div style="font-size:14px;line-height:1.55;color:var(--text-muted);margin-bottom:10px;">' +
            esc(Lang.t('paper.desc')) + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
            '<button class="btn btn-ghost" data-paper-act="refresh">' + esc(Lang.t('paper.refresh')) + '</button>' +
            // Trading est un module de PREMIER RANG : il n'y a plus de vue
            // parente ou revenir. A la place, l'acces au bot d'alertes.
            '<a class="btn btn-ghost btn-sm" href="https://t.me/OracleOmen_bot" ' +
                'target="_blank" rel="noopener noreferrer" style="text-decoration:none;" ' +
                'title="' + esc(Lang.t('paper.telegram_hint')) + '">' +
              esc(Lang.t('paper.telegram_btn')) + '</a>' +
          '</div>' +
        '</div>' +
        // Rappel permanent : argent fictif, cours différés, aucun conseil.
        '<div class="card" style="margin-bottom:14px;border-color:var(--warning);' +
             'background:var(--bg-elev-2);font-size:14px;line-height:1.5;">' +
          esc(Lang.t('paper.disclaimer')) +
        '</div>' +
        '<div class="paper-tabs" id="paper-tabs"></div>' +
        '<div id="paper-body"><div class="card">' + esc(Lang.t('paper.loading')) + '</div></div>' +
        // Le coach flottant vit HORS de #paper-body : il survit donc aux
        // re-rendus du corps (et à eux seuls — il part avec le module).
        '<div id="paper-fab-wrap"></div>';
    },

    _tabDefs() {
        return [
            ['portfolio', 'paper.tab_portfolio'],
            ['trade', 'paper.tab_trade'],
            ['journal', 'paper.tab_journal'],
            ['coach', 'paper.tab_coach'],
            ['lessons', 'paper.tab_lessons'],
            ['arena', 'paper.tab_arena'],
            ['whales', 'paper.tab_whales'],
            ['radar', 'paper.tab_radar'],
            ['plan', 'paper.tab_plan'],
            ['graph', 'paper.tab_graph'],
        ];
    },

    _renderTabs() {
        const host = document.getElementById('paper-tabs');
        if (!host) return;
        host.innerHTML = this._tabDefs().map((d) =>
            '<button class="paper-tab' + (this._tab === d[0] ? ' active' : '') + '" ' +
                'data-paper-tab="' + esc(d[0]) + '">' + esc(Lang.t(d[1])) + '</button>'
        ).join('');
    },

    _setBody(html) {
        const body = document.getElementById('paper-body');
        if (body) body.innerHTML = html;
        // Le DOM vient d'être remplacé : les boutons d'un appel EN COURS
        // repartent « actifs » alors que la requête tourne toujours. C'est ici,
        // et à un seul endroit, qu'on leur remet leur état d'attente.
        this._applyBusy();
    },

    _card(inner, extra) {
        return '<div class="card" style="margin-bottom:14px;' + (extra || '') + '">' + inner + '</div>';
    },

    _head(title, note) {
        return '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<h3 style="margin:0;font-size:17px;">' + esc(title) + '</h3>' +
            (note ? '<span style="font-size:12px;color:var(--text-dim);">' + esc(note) + '</span>' : '') +
        '</div>';
    },

    _sub(key) {
        return '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;' +
            'color:var(--text-dim);margin:14px 0 6px;">' + esc(Lang.t(key)) + '</div>';
    },

    _muted(txt) {
        return '<div style="font-size:14px;color:var(--text-muted);">' + esc(txt) + '</div>';
    },

    // Panneau de texte long (réponse du coach, post-mortem, fiche d'analyse).
    _panel(title, text) {
        return '<div style="margin-top:12px;">' +
            '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;' +
                 'color:var(--text-dim);margin-bottom:6px;">' + esc(title) + '</div>' +
            '<pre style="margin:0;white-space:pre-wrap;word-break:break-word;' +
                 'font-family:var(--font-mono);font-size:13px;line-height:1.6;' +
                 'background:var(--bg-elev-3);padding:12px 14px;border-radius:var(--r-md);' +
                 'max-height:460px;overflow:auto;">' + esc(text) + '</pre>' +
        '</div>';
    },

    _th() { return 'text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);' +
        'font-size:12px;color:var(--text-dim);font-weight:500;white-space:nowrap;'; },
    _td() { return 'padding:7px 10px;border-bottom:1px solid var(--border);font-size:14px;'; },

    _table(heads, rows) {
        if (!rows) return '';
        return '<div style="overflow-x:auto;"><table style="border-collapse:collapse;width:100%;min-width:520px;">' +
            '<thead><tr>' + heads.map((h) => '<th style="' + this._th() + '">' + esc(h) + '</th>').join('') +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    },

    // ------------------------------------------------------------- chargement

    async _tickAndLoad() {
        await this._tick();
        await this._loadPortfolio();
        await this._loadNews();
        await this._loadWatchlist();
    },

    // Veille de presse sur les positions détenues. Les alertes partent déjà sur
    // Telegram côté backend : ici c'est l'HISTORIQUE, pas la notification.
    async _loadNews() {
        const d = await this._get('/api/paper/news');
        if (!d) return;
        this._news = Array.isArray(d) ? d : (Array.isArray(d.events) ? d.events : []);
    },

    // POST /tick : passe les ordres en attente et les stops contre les bougies
    // récentes. Chaque exécution est signalée — un ordre qui part sans qu'on le
    // voie, c'est la moitié de la leçon perdue.
    async _tick() {
        let r = null;
        try { r = await Auth.apiCall('/api/paper/tick', { method: 'POST', body: JSON.stringify({}) }); }
        catch (e) { r = null; }
        if (!r || !r.ok) return;
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        const fills = (d && Array.isArray(d.fills)) ? d.fills : [];
        fills.forEach((f) => this._toast('info', this._fillLine(f)));
    },

    _fillLine(f) {
        if (!f || typeof f !== 'object') return Lang.t('paper.fill');
        const parts = [Lang.t('paper.fill')];
        if (f.symbol) parts.push(String(f.symbol));
        if (f.side) parts.push(this._sideLabel(f.side));
        const qty = this._n(this._pickField(f, ['qty', 'quantity']));
        if (qty !== null) parts.push(this._num(qty, 0));
        const px = this._n(this._pickField(f, ['price', 'fill_price', 'exec_price']));
        if (px !== null) parts.push('@ ' + this._num(px, 2));
        return parts.join(' ');
    },

    async _loadPortfolio() {
        const d = await this._get('/api/paper/portfolio');
        if (d) this._p = this._normalize(d);
        this._paintFeeBadge();
    },

    // Le portefeuille est la seule source de vérité de la vue : on le remet à
    // plat une fois pour toutes, avec des alias tolérants sur les noms de champs.
    _normalize(d) {
        const raw = (d && typeof d === 'object') ? d : {};
        const p = (raw.portfolio && typeof raw.portfolio === 'object') ? raw.portfolio : raw;
        const arr = (v) => (Array.isArray(v) ? v : []);
        const obj = (v) => ((v && typeof v === 'object' && !Array.isArray(v)) ? v : {});
        return {
            cash: this._n(this._pickField(p, ['cash_chf', 'cash'])),
            positions: arr(p.positions),
            orders: arr(this._pickField(p, ['open_orders', 'orders']) || []),
            trades: arr(p.trades),
            fee_profile: p.fee_profile || null,
            initial_capital: this._n(this._pickField(p, ['initial_capital', 'initial_capital_chf'])),
            exposure: obj(raw.exposure || p.exposure),
            afc: obj(raw.afc || p.afc),
            stats: obj(raw.stats || p.stats),
            biases: arr(raw.biases || p.biases),
            equity: this._equitySeries(raw, p),
        };
    },

    // La courbe d'équité peut arriver en nombres bruts ou en points datés.
    _equitySeries(raw, p) {
        const st = (raw.stats && typeof raw.stats === 'object') ? raw.stats : {};
        const src = this._pickField(st, ['equity_curve', 'equity']) ||
            this._pickField(raw, ['equity_curve', 'equity']) ||
            this._pickField(p, ['equity_curve', 'equity']);
        if (!Array.isArray(src)) return [];
        const out = [];
        src.forEach((pt) => {
            let v = null;
            if (pt && typeof pt === 'object') {
                v = this._n(this._pickField(pt, ['value', 'equity', 'total', 'total_value_chf', 'value_chf']));
            } else {
                v = this._n(pt);
            }
            if (v !== null) out.push(v);
        });
        return out;
    },

    _paintFeeBadge() {
        const el = document.getElementById('paper-feebadge');
        if (!el) return;
        const prof = this._p ? this._p.fee_profile : null;
        el.textContent = prof ? (Lang.t('paper.form_fee_profile') + ' ' + this._feeLabel(prof)) : '';
    },

    _feeLabel(id) { return this._label('paper.fee_' + String(id || '').toLowerCase(), id); },

    // Valeur totale : le champ du backend s'il existe, sinon reconstruite —
    // jamais un « — » silencieux quand l'information est calculable.
    _totalValue() {
        const p = this._p;
        if (!p) return null;
        const direct = this._n(this._pickField(p.stats, ['total_value_chf', 'total_value', 'equity_chf', 'equity'])) ;
        if (direct !== null) return direct;
        const exp = this._n(this._pickField(p.exposure, ['total_value_chf', 'total_value']));
        if (exp !== null) return exp;
        if (p.cash === null) return null;
        let sum = p.cash;
        p.positions.forEach((pos) => {
            const v = this._n(this._pickField(pos, ['value_chf', 'market_value_chf', 'value']));
            if (v !== null) { sum += v; return; }
            const qty = this._n(pos.qty);
            const last = this._n(this._pickField(pos, ['last_price', 'price', 'last']));
            const fx = this._n(this._pickField(pos, ['fx_rate_chf', 'fx'])) || 1;
            if (qty !== null && last !== null) sum += qty * last * fx;
        });
        return sum;
    },

    _pnlTotal() {
        const p = this._p;
        if (!p) return { chf: null, pct: null };
        let chf = this._n(this._pickField(p.stats, ['pnl_chf', 'pnl_total_chf', 'total_pnl_chf']));
        let pct = this._n(this._pickField(p.stats, ['pnl_pct', 'pnl_total_pct', 'total_pnl_pct']));
        const tv = this._totalValue();
        if (chf === null && tv !== null && p.initial_capital !== null) chf = tv - p.initial_capital;
        if (pct === null && chf !== null && p.initial_capital) pct = (chf / p.initial_capital) * 100;
        return { chf: chf, pct: pct };
    },

    _feesTotal() {
        const p = this._p;
        if (!p) return null;
        const direct = this._n(this._pickField(p.stats, ['fees_total_chf', 'fees_chf', 'total_fees_chf']));
        if (direct !== null) return direct;
        if (!p.trades.length) return null;
        let sum = 0;
        p.trades.forEach((t) => {
            sum += (this._n(t.fees_chf) || 0) + (this._n(t.stamp_duty_chf) || 0);
        });
        return sum;
    },

    // Capital de référence du calcul de taille : ce que le portefeuille VAUT
    // aujourd'hui, pas ce qu'il valait au départ.
    _capital() {
        const tv = this._totalValue();
        if (tv !== null) return tv;
        const p = this._p;
        if (p && p.initial_capital !== null) return p.initial_capital;
        return null;
    },

    // --------------------------------------------------------------- routage

    async _periodic() {
        await this._tick();
        await this._loadPortfolio();
        await this._loadNews();
        await this._loadWatchlist();
        // On ne réécrit le corps que là où aucune saisie n'est en cours : un
        // re-rendu au mauvais moment volerait le curseur au milieu d'un mot.
        // La garde reste, même si la vue Portefeuille ne porte plus de champ —
        // c'est le poll qui décide de réécrire, pas ce que la vue contient ce
        // mois-ci.
        if (this._tab === 'portfolio' && !this._typing()) this._renderBody();
    },

    // Y a-t-il une saisie EN COURS dans le module ?
    _typing() {
        const el = document.activeElement;
        if (!el || !this._container || !this._container.contains) return false;
        if (!this._container.contains(el)) return false;
        const tag = String(el.tagName || '').toLowerCase();
        return (tag === 'input' || tag === 'textarea' || tag === 'select');
    },

    switchTab(tab) {
        if (!tab || tab === this._tab) return;
        if (this._tab === 'trade') { this._captureForm(); this._saveDraft(); }
        this._tab = tab;
        this._saveUi();
        this._renderTabs();
        this._renderBody();
        this._loadTab();
    },

    // Chargements paresseux : un onglet ne va chercher ses données que la
    // première fois qu'on l'ouvre (le coach et l'arène ne bougent pas à la minute).
    async _loadTab() {
        if (this._tab === 'whales' && !this._whales) {
            this._whales = await this._get('/api/paper/whales') || {};
            this._whaleEvents = await this._get('/api/paper/whales/events');
            if (this._tab === 'whales') this._renderBody();
            return;
        }
        if (this._tab === 'radar' && !this._radar) {
            this._radar = await this._get('/api/paper/radar') || {};
            if (this._tab === 'radar') this._renderBody();
            return;
        }
        // Réglage du portefeuille : régime d'alertes. Lu UNE fois (il ne bouge
        // que si on le change), pas au poll de 60 s.
        if (this._tab === 'portfolio' && this._alertsMode === null) {
            await this._loadAlertsMode();
            if (this._tab === 'portfolio') this._renderBody();
            return;
        }
        if (this._tab === 'coach' && (!this._coach || !this._ideasJournal)) {
            if (!this._coach) {
                this._coach = await this._get(this._withLang('/api/paper/coach')) || {};
                this._notes = await this._get('/api/paper/coach/notes');
                this._community = await this._get('/api/paper/community');
            }
            if (!this._ideasJournal) await this._loadIdeasJournal();
            if (this._tab === 'coach') this._renderBody();
            return;
        }
        if (this._tab === 'lessons' && !this._lessons) {
            this._lessons = await this._get(this._withLang('/api/paper/lessons')) || {};
            if (this._tab === 'lessons') this._renderBody();
            return;
        }
        if (this._tab === 'arena' && !this._arena) {
            this._arena = await this._get(this._withLang('/api/paper/arena')) || {};
            if (this._tab === 'arena') this._renderBody();
            return;
        }
        if (this._tab === 'plan' && !this._board) {
            this._board = await this._get('/api/paper/board') || {};
            if (this._tab === 'plan') this._renderBody();
            return;
        }
        // La toile n'est relue qu'à la première ouverture (ou sur demande) : la
        // mémoire du module ne bouge pas à la minute.
        if (this._tab === 'graph' && !this._graph && !this._graphLoading) {
            await this.loadGraph(this._graphSymbol);
        }
    },

    // Un re-rendu detruit les canvases : on retire LEURS ecouteurs avant, on
    // rebranche les nouveaux apres (l'ecouteur resize vit sur window, il ne
    // meurt pas tout seul avec le DOM).
    _renderBody() {
        this._disposeCharts();
        this._disposeGraph();
        this._chartWanted = [];
        let html;
        if (this._tab === 'trade') html = this._viewTrade();
        else if (this._tab === 'journal') html = this._viewJournal();
        else if (this._tab === 'coach') html = this._viewCoach();
        else if (this._tab === 'lessons') html = this._viewLessons();
        else if (this._tab === 'arena') html = this._viewArena();
        else if (this._tab === 'whales') html = this._viewWhales();
        else if (this._tab === 'radar') html = this._viewRadar();
        else if (this._tab === 'plan') html = this._viewPlan();
        else if (this._tab === 'graph') html = this._viewGraph();
        else html = this._viewPortfolio();
        this._setBody(html);
        if (this._tab === 'portfolio') this._paintEquity();
        this._mountCharts();
        if (this._tab === 'graph') this._mountGraph();
    },

    async refresh() {
        await this._tickAndLoad();
        // Un rafraîchissement demandé À LA MAIN relit aussi l'onglet courant.
        if (this._tab === 'portfolio') {
            await this._loadAlertsMode();
        } else if (this._tab === 'coach') {
            this._coach = await this._get(this._withLang('/api/paper/coach')) || {};
            this._notes = await this._get('/api/paper/coach/notes');
            this._community = await this._get('/api/paper/community');
            await this._loadIdeasJournal();
        } else if (this._tab === 'lessons') {
            this._lessons = await this._get(this._withLang('/api/paper/lessons')) || {};
        } else if (this._tab === 'arena') {
            this._arena = await this._get(this._withLang('/api/paper/arena')) || {};
        } else if (this._tab === 'whales') {
            this._whales = await this._get('/api/paper/whales') || {};
            this._whaleEvents = await this._get('/api/paper/whales/events');
            // Un gerant deja ouvert est relu aussi : c'est un rafraichissement
            // DEMANDE, on assume les ~10 s (le loader le dit).
            if (this._whaleId) { this._renderBody(); await this.openWhale(this._whaleId, true); return; }
        } else if (this._tab === 'radar') {
            this._radar = await this._get('/api/paper/radar') || {};
        } else if (this._tab === 'plan') {
            this._board = await this._get('/api/paper/board') || this._board;
        } else if (this._tab === 'graph') {
            // loadGraph re-rend déjà : on lui laisse la main, sinon le canvas
            // serait monté deux fois pour rien.
            await this.loadGraph(this._graphSymbol);
            return;
        }
        this._renderBody();
    },

    // =====================================================================
    //  1. PORTEFEUILLE
    // =====================================================================

    _viewPortfolio() {
        if (!this._p) return this._card(this._muted(Lang.t('paper.no_data')));
        // « Favoris » vit SOUS les positions : d'abord ce que je détiens,
        // ensuite ce que je surveille, puis ce que j'ai commandé. Les réglages
        // d'alerte suivent le fil des actualités : on lit ce qui est arrivé,
        // puis on décide comment on veut être prévenu la prochaine fois.
        return this._statCards() + this._equityCard() + this._positionsCard() +
            this._reviewCard() + this._watchlistCard() + this._ordersCard() +
            this._newsCard() + this._alertsCard() + this._resetCard();
    },

    // --- Revue des positions : l'avis du coach sur ce que je DÉTIENS ---------
    //
    // Le coach ne passe aucun ordre et n'en propose aucun : il donne un avis
    // par ligne (garder / surveiller / alléger / sortir) avec sa raison. La
    // ligne d'honnêteté est permanente — c'est le lecteur qui tranche.

    _stance(v) {
        const s = String(v == null ? '' : v).toLowerCase();
        // Repli sur l'avis le plus neutre : on ne fait jamais dire « sortir »
        // à un code qu'on n'a pas su lire.
        return Object.prototype.hasOwnProperty.call(this._STANCES, s) ? s : 'surveiller';
    },

    _stanceBadge(v) {
        const s = this._stance(v);
        return '<span class="badge ' + this._STANCES[s] + '">' +
            esc(Lang.t('paper.stance_' + s)) + '</span>';
    },

    _reviewCard() {
        const d = this._review;
        if (!d) return '';
        const rows = Array.isArray(d.verdicts) ? d.verdicts : [];
        const td = this._td();
        const body = rows.map((v) =>
            '<tr>' +
              '<td style="' + td + this._mono + 'font-weight:600;">' +
                esc(String((v && v.symbol) || '')) + '</td>' +
              '<td style="' + td + '">' + this._stanceBadge(v && v.stance) + '</td>' +
              '<td style="' + td + 'line-height:1.55;">' +
                esc(String((v && v.reason) || '')) + '</td>' +
            '</tr>').join('');
        const text = String(d.text || '');
        return this._card(
            this._head(Lang.t('paper.review_title')) +
            '<div style="font-size:13px;color:var(--text-muted);line-height:1.5;margin-bottom:10px;">' +
              esc(Lang.t('paper.review_honesty')) + '</div>' +
            (body ? this._table([
                Lang.t('paper.col_symbol'), Lang.t('paper.review_stance'), Lang.t('paper.review_reason'),
            ], body) : this._muted(Lang.t('paper.review_no_verdicts'))) +
            (text
              ? '<div style="margin-top:10px;">' +
                  '<button class="btn btn-ghost btn-sm" data-paper-act="review-text">' +
                    esc(Lang.t(this._reviewOpen ? 'paper.hide_text' : 'paper.show_text')) + '</button>' +
                '</div>' + (this._reviewOpen ? this._panel(Lang.t('paper.review_title'), text) : '')
              : '')
        );
    },

    async reviewPositions() {
        // Garde côté client : sans position, l'appel ne peut que rendre 400.
        // On le dit clairement plutôt que d'aller chercher une erreur.
        const rows = (this._p && Array.isArray(this._p.positions)) ? this._p.positions : [];
        if (!rows.length) { this._toast('warn', Lang.t('paper.review_no_positions')); return; }
        let ok = false;
        await this._llm('review', '/api/paper/positions/review', { lang: this._lang() }, (d) => {
            this._review = (d && typeof d === 'object') ? d : null;
            this._reviewOpen = false;
            ok = true;
            this._arrived('review');
        });
        // La revue est une entrée de journal comme les idées : on le relit.
        if (ok) await this._refreshJournal();
    },

    // --- Réglages des alertes : régime de notification -----------------------
    //
    // Les comptes X suivis ne se règlent PLUS ici : leur veille est pilotée
    // côté serveur, et ce qu'elle trouve arrive tout seul dans le fil de presse
    // (badge « X » + pseudo sur l'événement). Un réglage de moins à l'écran
    // pour la même information à l'arrivée.

    _isAlertMode(v) { return this._ALERT_MODES.indexOf(String(v == null ? '' : v)) >= 0; },

    _alertsCard() {
        const mode = this._isAlertMode(this._alertsMode) ? this._alertsMode : 'calme';
        const pills = this._ALERT_MODES.map((m) =>
            '<button class="paper-tab' + (m === mode ? ' active' : '') + '" ' +
                'data-paper-act="alerts-mode" data-mode="' + esc(m) + '">' +
              esc(Lang.t('paper.alerts_' + m)) + '</button>'
        ).join('');
        return this._card(
            this._head(Lang.t('paper.alerts_title'), Lang.t('paper.telegram_btn')) +
            '<div class="paper-tabs" style="margin-bottom:6px;">' + pills + '</div>' +
            '<div style="font-size:13px;color:var(--text-dim);line-height:1.5;">' +
              esc(Lang.t('paper.alerts_' + mode + '_hint')) + '</div>'
        );
    },

    async setAlertsMode(mode) {
        const m = String(mode || '');
        if (!this._isAlertMode(m)) return;          // rien de forgé n'entre ici
        if (this._alertsBusy || m === this._alertsMode) return;
        this._alertsBusy = true;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/alerts-mode',
                { method: 'POST', body: JSON.stringify({ mode: m }) });
        } catch (e) { r = null; }
        this._alertsBusy = false;
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        // On relit la réponse du serveur plutôt que de croire notre clic :
        // c'est LUI qui décide de ce qui est enregistré.
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        this._alertsMode = this._isAlertMode(d && d.mode) ? String(d.mode) : m;
        this._toast('success', Lang.t('paper.alerts_saved'));
        if (this._tab === 'portfolio') this._renderBody();
    },

    async _loadAlertsMode() {
        const d = await this._get('/api/paper/alerts-mode');
        // Serveur muet → « calme » : le repli est le régime le plus discret.
        this._alertsMode = this._isAlertMode(d && d.mode) ? String(d.mode) : 'calme';
    },

    // --- Actualités des positions -------------------------------------------
    //
    // Composant Bento .row/.row-list + .badge. (Le .events-feed a été essayé :
    // sa colonne 'typ' fait 80 px fixes et coupait « CATALYSEUR À VENIR » —
    // vérifié à l'écran. Le badge est de toute façon LE composant du projet
    // pour un statut.)

    // « watch » n'est ni bon ni mauvais : c'est un catalyseur À VENIR (résultats
    // annoncés, OPA, lancement). Il mérite sa propre couleur — le classer en
    // positif ferait lire une nouvelle comme un avis, ce que le module ne fait jamais.
    _sentiment(v) {
        const s = String(v == null ? '' : v).toLowerCase();
        if (s === 'neg') return { cls: 'danger', color: 'var(--danger)', key: 'paper.news_neg' };
        if (s === 'watch') return { cls: 'warn', color: 'var(--warning)', key: 'paper.news_watch' };
        // Une annonce politique/presidentielle n'est pas un jugement sur le titre :
        // elle signale d'ou vient le mouvement, pas s'il est bon.
        if (s === 'gov') return { cls: 'warn', color: 'var(--warning)', key: 'paper.news_gov' };
        return { cls: 'online', color: 'var(--accent)', key: 'paper.news_pos' };
    },

    _newsCard() {
        const rows = Array.isArray(this._news) ? this._news : [];
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.news_title')) +
                this._muted(Lang.t('paper.news_empty')));
        }
        const feed = rows.map((e) => {
            const s = this._sentiment(e && e.sentiment);
            const url = this._safeUrl(e && e.link);
            const link = url
                ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
                  'class="btn btn-ghost btn-sm" style="text-decoration:none;">' +
                  esc(Lang.t('paper.open')) + '</a>'
                : '';
            // Le symbole est FACULTATIF : une nouvelle crypto ou un post X peut
            // parler du marché sans porter de ticker. On n'affiche alors ni la
            // pastille de symbole ni le badge « favori » — pas de chip vide.
            const sym = (e && e.symbol !== null && e.symbol !== undefined)
                ? String(e.symbol) : '';
            const src = String((e && e.src) || '').toLowerCase();
            const handle = String((e && e.handle) || '');
            return '<div class="row" style="display:flex;gap:10px;align-items:center;' +
                   'flex-wrap:wrap;padding:9px 12px;">' +
                '<span class="badge ' + s.cls + '">' + esc(Lang.t(s.key)) + '</span>' +
                (src === 'crypto'
                  ? '<span class="badge warn">' + esc(Lang.t('paper.kind_crypto')) + '</span>' : '') +
                (src === 'x'
                  ? '<span class="badge muted">' + esc(Lang.t('paper.news_src_x')) + '</span>' +
                    (handle
                      ? '<span style="' + this._mono + 'font-size:13px;color:var(--text-dim);">@' +
                        esc(handle) + '</span>' : '')
                  : '') +
                (sym
                  ? '<span style="' + this._mono + 'font-size:13px;font-weight:600;color:' +
                    s.color + ';">' + esc(sym) + '</span>' : '') +
                ((sym && this._isWatched(sym))
                  ? '<span class="badge">' + esc(Lang.t('paper.watchlist_title')) + '</span>' : '') +
                '<span style="flex:1 1 260px;min-width:0;font-size:14px;line-height:1.45;">' +
                  esc((e && e.title) || '') + '</span>' +
                '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(this._dateTime(e && e.ts)) + '</span>' +
                link +
            '</div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.news_title'), Lang.t('paper.news_hint')) +
            '<div class="row-list" style="max-height:340px;overflow:auto;">' + feed + '</div>');
    },

    _statCards() {
        const p = this._p;
        const pnl = this._pnlTotal();
        const fees = this._feesTotal();
        const tv = this._totalValue();
        // La devise passe par '.unit' (composant existant : 16 px, --text-dim)
        // — collée au nombre en 30 px, elle repoussait la valeur sur 2 lignes.
        const cell = (labelKey, value, valueColor, footer) =>
            '<div class="stat-card">' +
              '<div class="label">' + esc(Lang.t(labelKey)) + '</div>' +
              '<div class="value"' + (valueColor ? ' style="color:' + valueColor + ';"' : '') + '>' +
                esc(value) + '<span class="unit">CHF</span></div>' +
              (footer ? '<div class="footer">' + footer + '</div>' : '') +
            '</div>';
        const pnlFooter = (pnl.pct === null)
            ? ''
            : '<span style="' + this._mono + 'color:' + this._color(pnl.pct) + ';">' +
              esc(this._signed(pnl.pct, 2, '%')) + '</span>';
        return '<div class="bento-overview" style="grid-template-columns:repeat(5,1fr);' +
                    'grid-template-rows:auto;margin-bottom:14px;">' +
            cell('paper.cash', this._num(p.cash), '', '') +
            cell('paper.total_value', this._num(tv), '', '') +
            cell('paper.pnl_total', this._signed(pnl.chf, 2, ''), this._color(pnl.chf), pnlFooter) +
            cell('paper.fees_total', this._num(fees), '', '') +
            this._afcCard() +
        '</div>';
    },

    // Garde-fou fiscal suisse : l'utilisateur voit EN DIRECT s'il sortirait du
    // statut d'investisseur privé — la leçon la plus chère qu'on puisse ignorer.
    _afcCard() {
        const afc = this._p ? this._p.afc : {};
        const status = String(this._pickField(afc, ['status', 'state']) || '');
        const ratio = this._n(this._pickField(afc, ['volume_ratio', 'ratio', 'volume_x']));
        const atRisk = (status === 'a_risque' || status === 'at_risk');
        const badge = atRisk
            ? '<span class="badge warn">' + esc(Lang.t('paper.afc_at_risk')) + '</span>'
            : '<span class="badge online">' + esc(Lang.t('paper.afc_private')) + '</span>';
        const footer = (ratio === null)
            ? ''
            : '<span style="' + this._mono + '">' + esc(Lang.t('paper.afc_volume')) + ' ' +
              esc(this._num(ratio, 2)) + '×</span>';
        return '<div class="stat-card">' +
            '<div class="label">' + esc(Lang.t('paper.afc_status')) + '</div>' +
            '<div style="margin-top:6px;">' + badge + '</div>' +
            (footer ? '<div class="footer">' + footer + '</div>' : '') +
        '</div>';
    },

    _equityCard() {
        const vals = this._p ? this._p.equity : [];
        if (!vals || vals.length < 2) {
            return this._card(this._head(Lang.t('paper.equity_title')) +
                this._muted(Lang.t('paper.equity_empty')));
        }
        const neg = vals[vals.length - 1] < vals[0];
        return this._card(
            this._head(Lang.t('paper.equity_title'),
                this._num(vals.length, 0) + ' ' + Lang.t('paper.equity_points')) +
            '<svg class="paper-spark' + (neg ? ' neg' : '') + '" id="paper-equity" ' +
                 'viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true">' +
              '<polygon class="area" points=""></polygon>' +
              '<polyline points=""></polyline>' +
              '<circle class="tip" r="3"></circle>' +
            '</svg>' +
            '<div style="display:flex;justify-content:space-between;font-size:12px;' +
                 'color:var(--text-dim);' + this._mono + '">' +
              '<span>' + esc(this._chf(vals[0])) + '</span>' +
              '<span>' + esc(this._chf(vals[vals.length - 1])) + '</span>' +
            '</div>'
        );
    },

    // Même mécanisme que la sparkline CPU du Dashboard (Anim.sparkline pose les
    // points sur un <svg> préparé). Repli maison si anim.js n'est pas chargé —
    // aucune bibliothèque, aucun CDN.
    _paintEquity() {
        const svg = document.getElementById('paper-equity');
        const vals = this._p ? this._p.equity : [];
        if (!svg || !vals || vals.length < 2) return;
        if (typeof Anim !== 'undefined' && Anim.sparkline) { Anim.sparkline(svg, vals); return; }
        const W = 600, H = 120;
        let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
        if (max - min < 1e-9) { const mid = (max + min) / 2; min = mid - 1; max = mid + 1; }
        const step = W / (vals.length - 1);
        const pts = vals.map((v, i) => {
            const y = H - ((v - min) / (max - min)) * (H - 8) - 4;
            return (i * step).toFixed(1) + ',' + y.toFixed(1);
        });
        const line = pts.join(' ');
        const poly = svg.querySelector('polyline');
        const area = svg.querySelector('.area');
        const tip = svg.querySelector('.tip');
        if (poly) poly.setAttribute('points', line);
        if (area) area.setAttribute('points', '0,' + H + ' ' + line + ' ' + W + ',' + H);
        if (tip) {
            const last = pts[pts.length - 1].split(',');
            tip.setAttribute('cx', last[0]);
            tip.setAttribute('cy', last[1]);
        }
    },

    // En-tête des positions : le titre, son aide, et à droite « Analyser mes
    // positions ». Le bouton est là MÊME sans position (la fonction doit rester
    // visible) ; c'est reviewPositions qui dit gentiment qu'il n'y a rien à lire.
    _positionsHead() {
        return '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;' +
                    'margin-bottom:10px;">' +
            '<h3 style="margin:0;font-size:17px;">' + esc(Lang.t('paper.positions_title')) + '</h3>' +
            '<span style="font-size:12px;color:var(--text-dim);">' +
              esc(Lang.t('paper.positions_hint')) + '</span>' +
            '<button class="btn btn-sm" data-paper-act="review" data-paper-busy="review" ' +
                'style="margin-left:auto;">' + esc(Lang.t('paper.review_btn')) + '</button>' +
        '</div>';
    },

    _positionsCard() {
        const rows = this._p.positions;
        if (!rows.length) {
            return this._card(this._positionsHead() +
                this._muted(Lang.t('paper.positions_empty')));
        }
        const td = this._td();
        const body = rows.map((pos) => {
            const sym = String(pos.symbol || '');
            const qty = this._n(pos.qty);
            const avg = this._n(this._pickField(pos, ['avg_price', 'entry_price']));
            const last = this._n(this._pickField(pos, ['last_price', 'price', 'last']));
            const pnl = this._n(this._pickField(pos, ['pnl_chf', 'unrealized_pnl_chf', 'pnl']));
            const pnlPct = this._n(this._pickField(pos, ['pnl_pct', 'unrealized_pnl_pct']));
            const cur = pos.currency || '';
            return '<tr data-paper-act="pos-toggle" data-sym="' + esc(sym) + '" ' +
                   'style="cursor:pointer;' +
                   (this._posOpen === sym ? 'background:var(--bg-elev-2);' : '') + '">' +
                '<td style="' + td + '">' +
                  '<span style="font-weight:600;">' + esc(sym) + '</span>' +
                  '<span style="font-size:12px;color:var(--text-dim);margin-left:6px;">' +
                    esc(this._sideLabel(pos.side || 'long')) + '</span>' +
                '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._num(qty, 0)) + '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._money(avg, cur)) + '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._money(last, cur)) + '</td>' +
                '<td style="' + td + this._mono + 'color:' + this._color(pnl) + ';">' +
                  esc(this._signedChf(pnl)) +
                  (pnlPct === null ? '' : '<span style="font-size:12px;margin-left:6px;">' +
                    esc(this._signed(pnlPct, 2, '%')) + '</span>') +
                '</td>' +
                '<td style="' + td + '">' +
                  '<button class="btn btn-sm" data-paper-act="close-pos" data-sym="' + esc(sym) + '">' +
                    esc(Lang.t('paper.close_position')) + '</button>' +
                '</td>' +
            '</tr>';
        }).join('');
        // Clic sur une ligne -> le graphique de CETTE position se deplie dessous,
        // avec ses reperes stop / PRU.
        const open = this._posOpen ? this._positionChart(this._posOpen) : '';
        return this._card(this._positionsHead() +
            this._table([
                Lang.t('paper.col_symbol'), Lang.t('paper.col_qty'), Lang.t('paper.col_avg_price'),
                Lang.t('paper.col_last'), Lang.t('paper.col_pnl'), Lang.t('paper.col_actions'),
            ], body)) + open;
    },

    _ordersCard() {
        const rows = this._p.orders;
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.orders_title')) +
                this._muted(Lang.t('paper.orders_empty')));
        }
        const td = this._td();
        const body = rows.map((o) => {
            const id = String(this._pickField(o, ['id', 'order_id']) || '');
            const price = this._n(this._pickField(o, ['limit_price', 'stop_price']));
            return '<tr>' +
                '<td style="' + td + 'font-weight:600;">' + esc(o.symbol || '') + '</td>' +
                '<td style="' + td + '">' + esc(this._sideLabel(o.side)) + '</td>' +
                '<td style="' + td + '">' + esc(this._kindLabel(o.kind)) + '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._num(this._n(o.qty), 0)) + '</td>' +
                '<td style="' + td + this._mono + '">' + esc(this._num(price, 2)) + '</td>' +
                '<td style="' + td + this._mono + 'font-size:12px;color:var(--text-dim);">' +
                  esc(this._dateTime(o.created_at)) + '</td>' +
                '<td style="' + td + '">' +
                  (id ? '<button class="btn btn-sm" data-paper-act="cancel-order" data-id="' + esc(id) + '">' +
                    esc(Lang.t('paper.cancel_order')) + '</button>' : '') +
                '</td>' +
            '</tr>';
        }).join('');
        return this._card(this._head(Lang.t('paper.orders_title')) +
            this._table([
                Lang.t('paper.col_symbol'), Lang.t('paper.col_side'), Lang.t('paper.col_kind'),
                Lang.t('paper.col_qty'), Lang.t('paper.col_price'), Lang.t('paper.col_created'),
                Lang.t('paper.col_actions'),
            ], body));
    },


    // --- Favoris -------------------------------------------------------------
    //
    // Ce que l'utilisateur SURVEILLE, par opposition à ce qu'il détient. Le
    // backend s'en sert pour creuser les news et nourrir le coach ; ici on ne
    // fait que la tenir et offrir les deux raccourcis qui comptent (analyser,
    // trader). Les cours sont un CONFORT : un échec de /quotes laisse la liste
    // lisible plutôt que de la faire disparaître.

    _watchRows() {
        const w = this._watch;
        if (Array.isArray(w)) return w;
        if (w && Array.isArray(w.symbols)) return w.symbols;
        return [];
    },

    _isWatched(symbol) {
        const sym = String(symbol || '');
        if (!sym) return false;
        const rows = this._watchRows();
        for (let i = 0; i < rows.length; i++) {
            if (String(rows[i] && rows[i].symbol) === sym) return true;
        }
        return false;
    },

    async _loadWatchlist() {
        const d = await this._get('/api/paper/watchlist');
        if (d) this._watch = d;
        const rows = this._watchRows();
        if (!rows.length) { this._watchQuotes = {}; return; }
        const syms = rows.map((r) => String((r && r.symbol) || '')).filter(Boolean);
        if (!syms.length) return;
        // Un seul appel groupé pour toute la liste.
        const q = await this._get('/api/paper/quotes?symbols=' + encodeURIComponent(syms.join(',')));
        this._watchQuotes = (q && typeof q === 'object') ? q : {};
    },

    _watchlistCard() {
        const rows = this._watchRows();
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.watchlist_title')) +
                this._muted(Lang.t('paper.watchlist_empty')));
        }
        const td = this._td();
        const body = rows.map((r) => {
            const sym = String((r && r.symbol) || '');
            const q = this._watchQuotes[sym] || null;
            const chg = q ? this._n(q.change_pct) : null;
            return '<tr>' +
                '<td style="' + td + this._mono + 'font-weight:600;">' + esc(sym) + '</td>' +
                '<td style="' + td + '">' + esc((r && r.name) || '') + '</td>' +
                '<td style="' + td + this._mono + '">' +
                  esc(q ? this._money(q.price, q.currency || (r && r.currency)) : '—') + '</td>' +
                '<td style="' + td + this._mono + 'color:' + this._color(chg) + ';">' +
                  esc(chg === null ? '—' : this._signed(chg, 2, '%')) + '</td>' +
                '<td style="' + td + '">' +
                  '<span style="display:flex;gap:6px;flex-wrap:wrap;">' +
                    '<button class="btn btn-sm" data-paper-act="watch-analyze" ' +
                        'data-sym="' + esc(sym) + '">' + esc(Lang.t('paper.watchlist_analyze')) + '</button>' +
                    '<button class="btn btn-sm" data-paper-act="watch-trade" ' +
                        'data-sym="' + esc(sym) + '">' + esc(Lang.t('paper.watchlist_trade')) + '</button>' +
                    '<button class="btn btn-ghost btn-sm" data-paper-act="watch-remove" ' +
                        'data-sym="' + esc(sym) + '" style="color:var(--danger);">' +
                      esc(Lang.t('paper.watchlist_remove')) + '</button>' +
                  '</span>' +
                '</td>' +
            '</tr>';
        }).join('');
        return this._card(this._head(Lang.t('paper.watchlist_title')) +
            this._table([
                Lang.t('paper.col_symbol'), Lang.t('paper.watchlist_name'),
                Lang.t('paper.col_last'), Lang.t('paper.watchlist_change'),
                Lang.t('paper.col_actions'),
            ], body));
    },

    async addWatch(symbol) {
        const sym = String(symbol || '');
        if (!sym || this._isWatched(sym)) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/watchlist',
                { method: 'POST', body: JSON.stringify({ symbol: sym }) });
        } catch (e) { r = null; }
        if (!r || !r.ok) {
            // 400 = la liste est pleine. On le DIT, on ne laisse pas le bouton muet.
            this._toast('warn', (r && r.status === 400)
                ? Lang.t('paper.watchlist_full') : await this._detail(r));
            return;
        }
        await this._loadWatchlist();
        this._renderBody();
    },

    async removeWatch(symbol) {
        const sym = String(symbol || '');
        if (!sym) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/watchlist/' + encodeURIComponent(sym),
                { method: 'DELETE' });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        await this._loadWatchlist();
        this._renderBody();
    },

    // Raccourci « Trader » : ouvre Nouveau trade sur ce titre, rien de plus.
    async openTrade(symbol) {
        if (!symbol) return;
        this._tab = 'trade';
        this._renderTabs();
        this._renderBody();
        await this.pick(symbol, '', '', '');
    },

    // Raccourci « Analyser » : bascule sur le Coach, champ symbole prérempli.
    analyzeSymbol(symbol) {
        if (!symbol) return;
        this._analysisPrefill = String(symbol);
        this._tab = 'coach';
        this._renderTabs();
        this._renderBody();
        this._loadTab();
    },

    async closePosition(symbol) {
        if (!symbol) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/positions/' + encodeURIComponent(symbol) + '/close',
                { method: 'POST', body: JSON.stringify({}) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._toast('success', Lang.t('paper.closed_ok') + ' ' + symbol);
        await this._loadPortfolio();
        this._renderBody();
    },

    async cancelOrder(id) {
        if (!id) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/orders/' + encodeURIComponent(id) + '/cancel',
                { method: 'POST', body: JSON.stringify({}) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._toast('success', Lang.t('paper.cancelled_ok'));
        await this._loadPortfolio();
        this._renderBody();
    },

    // =====================================================================
    //  2. NOUVEAU TRADE
    // =====================================================================

    _viewTrade() {
        // Le graphique se glisse ENTRE la recherche et le formulaire : c'est
        // le moment ou on regarde la courbe avant de decider.
        const chart = (this._pick && this._pick.symbol)
            ? this._chartCard('trade', this._pick.symbol, this._pick.currency) : '';
        return this._searchCard() + chart + this._orderCard();
    },

    _searchCard() {
        const q = this._form.q || '';
        let results = '';
        if (this._results === null) {
            results = '';
        } else if (!this._results.length) {
            results = this._muted(Lang.t('paper.search_empty'));
        } else {
            results = '<div class="row-list" style="margin-top:10px;">' + this._results.map((x) => {
                const sym = String(x.symbol || '');
                return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                       'flex-wrap:wrap;padding:8px 12px;cursor:pointer;" ' +
                       'data-paper-act="pick" data-sym="' + esc(sym) + '" ' +
                       'data-name="' + esc(x.name || '') + '" ' +
                       'data-cur="' + esc(x.currency || '') + '" ' +
                       'data-exch="' + esc(x.exchange || '') + '">' +
                    '<div style="flex:1 1 220px;min-width:0;">' +
                      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
                        '<span style="font-size:15px;">' + esc(x.name || sym) + '</span>' +
                        // Crypto, forex, ETF : la nature de l'actif se voit AVANT
                        // le clic — c'est elle qui change la façon de le traiter.
                        this._kindBadge(x.kind) +
                      '</div>' +
                      '<div style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                        esc(sym) + (x.exchange ? ' · ' + esc(String(x.exchange)) : '') +
                        (x.currency ? ' · ' + esc(String(x.currency)) : '') + '</div>' +
                    '</div>' +
                    '<span class="badge">' + esc(Lang.t('paper.pick')) + '</span>' +
                    // Déjà suivi ? Le bouton reste VISIBLE mais désactivé — il
                    // répond ainsi à la question « est-ce que je le suis déjà ? ».
                    '<button class="btn btn-ghost btn-sm" data-paper-act="watch-add" ' +
                        'data-sym="' + esc(sym) + '"' + (this._isWatched(sym) ? ' disabled' : '') + '>' +
                      esc(Lang.t('paper.watchlist_add')) + '</button>' +
                '</div>';
            }).join('') + '</div>';
        }
        return this._card(
            this._head(Lang.t('paper.search_label'), Lang.t('paper.search_hint')) +
            '<input id="paper-q" class="form-input" autocomplete="off" ' +
                 'placeholder="' + esc(Lang.t('paper.search_placeholder')) + '" ' +
                 'value="' + esc(q) + '" />' +
            results
        );
    },

    _orderCard() {
        if (!this._pick) return this._card(this._muted(Lang.t('paper.pick_first')));
        const f = this._form;
        const cur = this._pick.currency || '';
        const kind = f.kind || 'market';
        const side = f.side || 'buy';
        const feeProfile = f.fee_profile || (this._p && this._p.fee_profile) || 'yuh';
        const opt = (val, labelKey, sel) =>
            '<option value="' + esc(val) + '"' + (sel === val ? ' selected' : '') + '>' +
            esc(Lang.t(labelKey)) + '</option>';
        // max-width : sans lui, le dernier champ d'une ligne qui se replie
        // s'étire sur toute la largeur (vu à l'écran sur « Profil de frais »).
        const field = (labelKey, inner, flex) =>
            '<div style="flex:1 1 ' + (flex || '150px') + ';min-width:0;max-width:260px;">' +
              '<label class="form-label">' + esc(Lang.t(labelKey)) + '</label>' + inner + '</div>';
        const numInput = (id, val, ph) =>
            '<input id="' + id + '" class="form-input" type="number" step="any" data-paper-size="1" ' +
            'value="' + esc(val === undefined || val === null ? '' : val) + '" ' +
            'placeholder="' + esc(ph || '') + '" />';

        const quoteLine = this._quote
            ? '<div style="font-size:13px;color:var(--text-muted);' + this._mono + 'margin-bottom:10px;">' +
              esc(Lang.t('paper.last_price')) + ' ' +
              esc(this._money(this._quote.price, this._quote.currency || cur)) +
              (this._n(this._quote.change_pct) === null ? '' :
                ' <span style="color:' + this._color(this._quote.change_pct) + ';">' +
                esc(this._signed(this._quote.change_pct, 2, '%')) + '</span>') +
              '</div>'
            : '';

        return this._card(
            this._head(Lang.t('paper.order_title'),
                this._pick.symbol + (this._pick.name ? ' — ' + this._pick.name : '')) +
            quoteLine +
            '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
              field('paper.form_side',
                '<select id="paper-side" class="form-input" data-paper-size="1">' +
                  opt('buy', 'paper.side_buy', side) + opt('sell', 'paper.side_sell', side) +
                  opt('short', 'paper.side_short', side) + opt('cover', 'paper.side_cover', side) +
                '</select>') +
              field('paper.form_kind',
                '<select id="paper-kind" class="form-input" data-paper-size="1">' +
                  opt('market', 'paper.kind_market', kind) + opt('limit', 'paper.kind_limit', kind) +
                  opt('stop', 'paper.kind_stop', kind) +
                '</select>') +
              field('paper.form_qty', numInput('paper-qty', f.qty, '')) +
              (kind === 'limit' ? field('paper.form_limit_price', numInput('paper-limit', f.limit_price, '')) : '') +
              (kind === 'stop' ? field('paper.form_stop_price', numInput('paper-stop', f.stop_price, '')) : '') +
              field('paper.form_stop_loss', numInput('paper-sl', f.stop_loss, '')) +
              field('paper.form_target', numInput('paper-target', f.target, '')) +
              field('paper.form_fee_profile',
                '<select id="paper-feeprofile" class="form-input">' +
                  opt('yuh', 'paper.fee_yuh', feeProfile) +
                  opt('swissquote', 'paper.fee_swissquote', feeProfile) +
                  opt('ibkr', 'paper.fee_ibkr', feeProfile) +
                '</select>') +
            '</div>' +
            '<div style="margin-top:12px;">' +
              '<label class="form-label">' + esc(Lang.t('paper.form_thesis')) + '</label>' +
              '<textarea id="paper-thesis" class="form-input" rows="4" ' +
                   'style="resize:vertical;line-height:1.5;" ' +
                   'placeholder="' + esc(Lang.t('paper.form_thesis_ph')) + '">' +
                esc(f.thesis || '') + '</textarea>' +
            '</div>' +
            // Aide au dimensionnement : la seule chose que le coach ne négocie pas.
            '<div id="paper-sizing" style="margin-top:10px;font-size:13px;' + this._mono +
                 'color:var(--text-muted);">' + esc(this._sizingText()) + '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
              '<button class="btn btn-primary" data-paper-act="submit-order">' +
                esc(Lang.t('paper.submit_order')) + '</button>' +
            '</div>'
        );
    },

    // Lit le formulaire tel qu'il est À L'ÉCRAN (le re-rendu du corps ne doit
    // jamais avaler ce qui a été tapé).
    _captureForm() {
        const val = (id) => {
            const el = document.getElementById(id);
            return el ? el.value : undefined;
        };
        const f = this._form;
        const q = val('paper-q'); if (q !== undefined) f.q = q;
        const side = val('paper-side'); if (side !== undefined) f.side = side;
        const kind = val('paper-kind'); if (kind !== undefined) f.kind = kind;
        const qty = val('paper-qty'); if (qty !== undefined) f.qty = qty;
        const lim = val('paper-limit'); if (lim !== undefined) f.limit_price = lim;
        const stp = val('paper-stop'); if (stp !== undefined) f.stop_price = stp;
        const sl = val('paper-sl'); if (sl !== undefined) f.stop_loss = sl;
        const tg = val('paper-target'); if (tg !== undefined) f.target = tg;
        const th = val('paper-thesis'); if (th !== undefined) f.thesis = th;
        const fp = val('paper-feeprofile'); if (fp !== undefined) f.fee_profile = fp;
    },

    // Prix d'entrée retenu pour le calcul : le prix POSÉ (limite/stop) prime sur
    // le dernier cours — c'est le prix auquel on entrera vraiment.
    _entryPrice() {
        const f = this._form;
        const kind = f.kind || 'market';
        if (kind === 'limit') {
            const v = this._n(f.limit_price);
            if (v !== null) return v;
        }
        if (kind === 'stop') {
            const v = this._n(f.stop_price);
            if (v !== null) return v;
        }
        return this._quote ? this._n(this._quote.price) : null;
    },

    _sizingText() {
        const cap = this._capital();
        const entry = this._entryPrice();
        const stop = this._n(this._form.stop_loss);
        if (cap === null || entry === null || stop === null || entry === stop) {
            return Lang.t('paper.sizing_need_stop');
        }
        const fx = (this._quote && this._n(this._quote.fx_rate_chf)) || 1;
        const perShare = Math.abs(entry - stop) * fx;
        if (!(perShare > 0)) return Lang.t('paper.sizing_need_stop');
        const line = (pct) => {
            const risk = cap * pct / 100;
            const n = Math.floor(risk / perShare);
            return this._num(pct, 0) + ' % (' + this._chf(risk) + ') : ' +
                this._num(n, 0) + ' ' + Lang.t('paper.sizing_shares');
        };
        return Lang.t('paper.sizing_risk') + ' ' + line(1) + '  ·  ' + line(2);
    },

    _paintSizing() {
        const el = document.getElementById('paper-sizing');
        if (el) el.textContent = this._sizingText();
    },

    async search(q) {
        const term = String(q || '').trim();
        if (term.length < 2) { this._results = null; this._redrawSearch(); return; }
        const d = await this._get('/api/paper/search?q=' + encodeURIComponent(term));
        const rows = Array.isArray(d) ? d : ((d && Array.isArray(d.results)) ? d.results : []);
        this._results = rows;
        this._redrawSearch();
    },

    // Redessine la LISTE seulement : on ne touche pas au champ de saisie, le
    // curseur de l'utilisateur y est.
    _redrawSearch() {
        if (this._tab !== 'trade') return;
        this._captureForm();
        this._renderBody();
        const el = document.getElementById('paper-q');
        if (el) {
            const v = el.value;
            el.focus();
            try { el.setSelectionRange(v.length, v.length); } catch (e) { /* type non supporté */ }
        }
    },

    async pick(symbol, name, currency, exchange) {
        if (!symbol) return;
        this._captureForm();
        this._saveDraft();                  // le brouillon du titre PRÉCÉDENT
        this._pick = { symbol: symbol, name: name || '', currency: currency || '', exchange: exchange || '' };
        this._results = null;
        this._quote = null;
        // Un brouillon est rangé PAR TITRE : on repart de celui-ci, pas de la
        // saisie laissée sur un autre. Le champ de recherche, lui, survit.
        const keepQ = this._form.q;
        this._form = { q: keepQ };
        this._loadDraft(symbol);
        this._saveUi();
        this._renderBody();
        // Mémoire du coach sur ce titre : lecture seule, aucun appel LLM.
        this._loadSymIdeas(symbol);
        // Et ce que la TOILE en sait déjà : un simple compteur, silencieux
        // tant qu'il vaut 0.
        this._loadGraphCount(symbol);
        const d = await this._get('/api/paper/quotes?symbols=' + encodeURIComponent(symbol));
        const q = (d && typeof d === 'object') ? (d[symbol] || d[String(symbol).toUpperCase()] || null) : null;
        if (q && typeof q === 'object') this._quote = q;
        if (this._tab === 'trade') { this._captureForm(); this._renderBody(); }
    },

    async submitOrder() {
        this._captureForm();
        if (!this._pick || !this._pick.symbol) { this._toast('warn', Lang.t('paper.symbol_required')); return; }
        const qty = this._n(this._form.qty);
        if (qty === null || qty <= 0) { this._toast('warn', Lang.t('paper.qty_required')); return; }
        const kind = this._form.kind || 'market';
        const body = {
            symbol: this._pick.symbol,
            side: this._form.side || 'buy',
            kind: kind,
            qty: qty,
            thesis: String(this._form.thesis || ''),
            fee_profile: this._form.fee_profile || undefined,
        };
        if (kind === 'limit') body.limit_price = this._n(this._form.limit_price);
        if (kind === 'stop') body.stop_price = this._n(this._form.stop_price);
        const sl = this._n(this._form.stop_loss);
        if (sl !== null) body.stop_loss = sl;
        const tg = this._n(this._form.target);
        if (tg !== null) body.target = tg;

        let r = null;
        try { r = await Auth.apiCall('/api/paper/orders', { method: 'POST', body: JSON.stringify(body) }); }
        catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        // Les avertissements du backend (thèse vide, pas de stop, risque > 2 %)
        // sont affichés — on AVERTIT, on ne bloque JAMAIS.
        const warnings = (d && Array.isArray(d.warnings)) ? d.warnings : [];
        warnings.forEach((w) => {
            const txt = (w && typeof w === 'object') ? (w.message || w.detail || w.code || '') : w;
            if (txt) this._toast('warn', String(txt));
        });
        this._toast('success', Lang.t('paper.order_ok'));
        // L'ordre est PASSÉ : le brouillon a fait son travail, il disparaît.
        this._dropDraft(this._pick.symbol);
        // Le titre choisi reste sélectionné (on enchaîne souvent), la saisie part.
        const keepQ = this._form.q;
        this._form = { q: keepQ, side: this._form.side, kind: this._form.kind,
            fee_profile: this._form.fee_profile };
        await this._loadPortfolio();
        if (this._tab === 'trade') this._renderBody();
    },

    // =====================================================================
    //  3. JOURNAL
    // =====================================================================

    _viewJournal() {
        if (!this._p) return this._card(this._muted(Lang.t('paper.no_data')));
        const trades = this._p.trades;
        if (!trades.length) {
            return this._card(this._head(Lang.t('paper.journal_title')) +
                this._muted(Lang.t('paper.journal_empty')));
        }
        const td = this._td();
        // Le plus récent en tête : on relit ce qu'on vient de faire.
        const idx = trades.map((t, i) => i).reverse();
        const body = idx.map((i) => {
            const t = trades[i] || {};
            const r = this._n(t.r_multiple);
            const pnl = this._n(t.pnl_chf);
            const fees = (this._n(t.fees_chf) || 0) + (this._n(t.stamp_duty_chf) || 0);
            const selected = (this._tradeIdx === i);
            return '<tr data-paper-act="open-trade" data-idx="' + esc(String(i)) + '" ' +
                   'style="cursor:pointer;' + (selected ? 'background:var(--bg-elev-2);' : '') + '">' +
                '<td style="' + td + this._mono + 'font-size:12px;color:var(--text-dim);">' +
                  esc(this._date(t.exit_at)) + '</td>' +
                '<td style="' + td + 'font-weight:600;">' + esc(t.symbol || '') + '</td>' +
                '<td style="' + td + '">' + esc(this._sideLabel(t.side)) + '</td>' +
                '<td style="' + td + this._mono + 'font-weight:600;color:' + this._color(r) + ';">' +
                  esc(r === null ? '—' : this._signed(r, 2, ' R')) + '</td>' +
                '<td style="' + td + this._mono + 'color:' + this._color(pnl) + ';">' +
                  esc(this._signedChf(pnl)) + '</td>' +
                '<td style="' + td + this._mono + 'color:var(--text-muted);">' +
                  esc(this._chf(fees)) + '</td>' +
                '<td style="' + td + 'font-size:13px;color:var(--text-muted);">' +
                  esc(t.exit_reason || '') + '</td>' +
            '</tr>';
        }).join('');
        return this._card(this._head(Lang.t('paper.journal_title'),
                Lang.t('paper.journal_hint')) +
            this._table([
                Lang.t('paper.col_date'), Lang.t('paper.col_symbol'), Lang.t('paper.col_side'),
                Lang.t('paper.col_r'), Lang.t('paper.col_pnl'), Lang.t('paper.col_fees'),
                Lang.t('paper.col_exit_reason'),
            ], body)) + this._tradeDetail();
    },

    _tradeDetail() {
        if (this._tradeIdx === null || !this._p) return '';
        const t = this._p.trades[this._tradeIdx];
        if (!t) return '';
        const cur = t.currency || '';
        const line = (labelKey, value) =>
            '<div style="display:flex;gap:10px;align-items:baseline;">' +
              '<span style="font-size:12px;color:var(--text-dim);min-width:150px;">' +
                esc(Lang.t(labelKey)) + '</span>' +
              '<span style="font-size:14px;' + this._mono + '">' + esc(value) + '</span>' +
            '</div>';
        return this._card(
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
              '<h3 style="margin:0;font-size:17px;">' + esc(Lang.t('paper.detail_title')) + ' — ' +
                esc(t.symbol || '') + '</h3>' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="close-trade" ' +
                      'style="margin-left:auto;">' + esc(Lang.t('paper.close')) + '</button>' +
            '</div>' +
            '<div style="display:grid;gap:4px;">' +
              line('paper.entry', this._money(t.entry_price, cur) + '  ' + this._dateTime(t.entry_at)) +
              line('paper.exit', this._money(t.exit_price, cur) + '  ' + this._dateTime(t.exit_at)) +
              line('paper.planned_stop', this._num(this._n(t.planned_stop), 2)) +
              line('paper.col_qty', this._num(this._n(t.qty), 0)) +
              line('paper.col_r', this._n(t.r_multiple) === null ? '—' : this._signed(t.r_multiple, 2, ' R')) +
              line('paper.col_pnl', this._signedChf(this._n(t.pnl_chf)) +
                (this._n(t.pnl_pct) === null ? '' : '  ' + this._signed(t.pnl_pct, 2, '%'))) +
              line('paper.col_fees', this._chf((this._n(t.fees_chf) || 0) + (this._n(t.stamp_duty_chf) || 0))) +
              line('paper.col_exit_reason', t.exit_reason || '—') +
            '</div>' +
            this._sub('paper.thesis_label') +
            '<div style="font-size:14px;line-height:1.6;background:var(--bg-elev-3);' +
                 'padding:10px 12px;border-radius:var(--r-md);white-space:pre-wrap;">' +
              esc(t.thesis ? String(t.thesis) : Lang.t('paper.thesis_empty')) +
            '</div>' +
            '<div style="margin-top:12px;">' +
              '<button class="btn btn-primary" data-paper-act="postmortem" data-paper-busy="postmortem" ' +
                      'data-idx="' + esc(String(this._tradeIdx)) + '">' +
                esc(Lang.t('paper.postmortem')) + '</button>' +
            '</div>' +
            (this._postmortem ? this._panel(Lang.t('paper.postmortem_title'), this._postmortem) : '')
        );
    },

    // =====================================================================
    //  4. COACH
    // =====================================================================

    _viewCoach() {
        if (!this._coach) return this._card(this._muted(Lang.t('paper.loading')));
        return this._biasesCard() + this._summaryCard() + this._askCard() +
            this._ideasCard() + this._journalCard() + this._analysisCard() + this._notesCard();
    },

    _biasList() {
        const c = this._coach || {};
        if (Array.isArray(c.biases)) return c.biases;
        if (Array.isArray(c)) return c;
        if (this._p && Array.isArray(this._p.biases)) return this._p.biases;
        return [];
    },

    _biasesCard() {
        const rows = this._biasList();
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.biases_title')) +
                this._muted(Lang.t('paper.biases_empty')));
        }
        const cards = rows.map((b) => {
            const code = String((b && b.code) || '');
            const sev = String((b && b.severity) || '');
            const critical = (sev === 'critical' || sev === 'crit');
            const borderColor = critical ? 'var(--danger)' : 'var(--warning)';
            const sevLabel = critical ? Lang.t('paper.severity_critical') : Lang.t('paper.severity_warn');
            const ev = (b && Array.isArray(b.evidence)) ? b.evidence : [];
            const evHtml = ev.length
                ? '<div style="margin-top:8px;">' +
                  '<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px;">' +
                    esc(Lang.t('paper.evidence')) + '</div>' +
                  '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;">' +
                    ev.map((e) => {
                        const txt = (e && typeof e === 'object')
                            ? (e.text || e.message || e.symbol || JSON.stringify(e)) : e;
                        return '<li>' + esc(String(txt)) + '</li>';
                    }).join('') +
                  '</ul></div>'
                : '';
            const desc = (b && (b.message || b.detail || b.description)) || '';
            return '<div style="border:1px solid ' + borderColor + ';border-radius:var(--r-md);' +
                        'padding:12px 14px;margin-bottom:10px;">' +
                '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
                  '<span style="font-size:15px;font-weight:600;">' + esc(this._biasLabel(code)) + '</span>' +
                  '<span class="badge ' + (critical ? 'danger' : 'warn') + '">' + esc(sevLabel) + '</span>' +
                  '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                    esc(code) + '</span>' +
                '</div>' +
                (desc ? '<div style="font-size:14px;line-height:1.55;margin-top:6px;">' +
                    esc(String(desc)) + '</div>' : '') +
                evHtml +
            '</div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.biases_title'), Lang.t('paper.biases_hint')) + cards);
    },

    _summaryCard() {
        const c = this._coach || {};
        const s = this._pickField(c, ['coach_summary', 'summary', 'profile']);
        if (!s) return '';
        if (typeof s === 'string') {
            return this._card(this._head(Lang.t('paper.profile_title')) + this._panel('', s));
        }
        const listOf = (v) => {
            if (Array.isArray(v)) return v;
            if (v === null || v === undefined || v === '') return [];
            return [v];
        };
        const block = (labelKey, items) => {
            const rows = listOf(items);
            if (!rows.length) return '';
            return this._sub(labelKey) +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                rows.map((x) => {
                    const txt = (x && typeof x === 'object')
                        ? (x.label || x.code || x.title || x.text || JSON.stringify(x)) : x;
                    const isCode = (x && typeof x === 'object' && x.code) ? x.code : null;
                    return '<span class="badge">' +
                        esc(isCode ? this._biasLabel(isCode) : String(txt)) + '</span>';
                }).join('') + '</div>';
        };
        const inner =
            block('paper.top_biases', this._pickField(s, ['top_biases', 'top', 'biases'])) +
            block('paper.recent_progress', this._pickField(s, ['recent_progress', 'progress'])) +
            block('paper.milestones', this._pickField(s, ['milestones', 'achievements']));
        const note = this._pickField(s, ['note', 'text', 'summary']);
        if (!inner && !note) return '';
        return this._card(this._head(Lang.t('paper.profile_title')) + inner +
            (note ? this._panel('', String(note)) : ''));
    },

    _askCard() {
        return this._card(
            this._head(Lang.t('paper.ask_title'), Lang.t('paper.ask_hint')) +
            '<textarea id="paper-question" class="form-input" rows="3" ' +
                 'style="resize:vertical;line-height:1.5;" ' +
                 'placeholder="' + esc(Lang.t('paper.ask_placeholder')) + '"></textarea>' +
            '<div style="margin-top:10px;">' +
              '<button class="btn btn-primary" data-paper-act="ask" data-paper-busy="ask">' +
                esc(Lang.t('paper.ask_send')) + '</button>' +
            '</div>' +
            (this._answer ? this._panel(Lang.t('paper.answer_title'), this._answer) : '')
        );
    },


    // --- Idées du coach ------------------------------------------------------
    //
    // Le coach ne dit toujours pas quoi acheter : il propose des paris RAISONNÉS,
    // que le radar note ensuite à l'échéance. La ligne d'honnêteté est
    // permanente, pas un pied de page qu'on oublie de lire.

    // La direction arrive du backend DANS LA LANGUE demandée (cf. _withLang) :
    // on ne la retraduit pas, on la colore.
    _direction(v) {
        const d = String(v == null ? '' : v).toLowerCase();
        if (d === 'down' || d === 'baisse' || d === 'ribasso' || d === 'short') {
            return 'danger';
        }
        if (d === 'up' || d === 'hausse' || d === 'rialzo' || d === 'long') {
            return 'online';
        }
        return '';
    },

    _ideasCard() {
        const d = this._ideas;
        const rows = (d && Array.isArray(d.ideas)) ? d.ideas : [];
        const cards = rows.map((it) => {
            const ticker = String((it && it.ticker) || '');
            const horizon = this._n(it && it.horizon_days);
            const tracked = !!(it && it.tracked);
            return '<div class="row" style="display:block;padding:10px 12px;">' +
                '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
                  // Le ticker EST le raccourci : un clic ouvre Nouveau trade dessus.
                  (ticker
                    ? '<button class="btn btn-ghost btn-sm" data-paper-act="idea-pick" ' +
                          'data-sym="' + esc(ticker) + '" style="' + this._mono +
                          'font-weight:600;">' + esc(ticker) + '</button>'
                    : '') +
                  (it && it.direction
                    ? '<span class="badge ' + this._direction(it.direction) + '">' +
                      esc(String(it.direction)) + '</span>' : '') +
                  this._kindBadge(it && it.asset_kind) +
                  (horizon === null ? '' :
                    '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                    esc(Lang.t('paper.radar_horizon') + ' ' + this._num(horizon, 0) + ' ' +
                        Lang.t('paper.radar_days')) + '</span>') +
                  '<span class="badge' + (tracked ? ' online' : '') + '" style="margin-left:auto;">' +
                    esc(tracked ? Lang.t('paper.ideas_tracked') : Lang.t('paper.ideas_untracked')) +
                  '</span>' +
                '</div>' +
                (it && it.thesis
                  ? '<div style="font-size:14px;line-height:1.55;margin-top:6px;">' +
                    esc(String(it.thesis)) + '</div>' : '') +
            '</div>';
        }).join('');
        // Le niveau se choisit AVANT de demander : c'est lui qui décide de la
        // nature des paris proposés, pas un filtre appliqué après coup.
        const level = this._riskLevel();
        const pills = this._LEVELS.map((lv) =>
            '<button class="paper-tab' + (lv === level ? ' active' : '') + '" ' +
                'data-paper-act="idea-level" data-level="' + esc(lv) + '">' +
              esc(Lang.t('paper.level_' + lv)) + '</button>'
        ).join('');

        return this._card(
            this._head(Lang.t('paper.ideas_title')) +
            '<div style="font-size:13px;color:var(--text-muted);line-height:1.5;margin-bottom:10px;">' +
              esc(Lang.t('paper.ideas_hint')) + '<br>' +
              // Mention permanente, pas un pied de page qu'on oublie de lire :
              // monter en volatilité ne change PAS la règle de risque.
              esc(Lang.t('paper.ideas_spec_note')) + '</div>' +
            '<div class="paper-tabs" style="margin-bottom:6px;">' + pills + '</div>' +
            '<div style="font-size:13px;color:var(--text-dim);line-height:1.5;margin-bottom:10px;">' +
              esc(Lang.t('paper.level_' + level + '_hint')) + '</div>' +
            '<button class="btn btn-primary" data-paper-act="ideas" data-paper-busy="ideas">' +
              esc(Lang.t('paper.ideas_btn')) + '</button>' +
            ((d && d.text) ? this._panel(Lang.t('paper.ideas_title'), String(d.text)) : '') +
            (cards ? '<div class="row-list" style="margin-top:12px;">' + cards + '</div>' : '')
        );
    },

    async askIdeas() {
        const body = { lang: this._lang(), risk_level: this._riskLevel() };
        let ok = false;
        await this._llm('ideas', '/api/paper/ideas', body, (d) => {
            this._ideas = (d && typeof d === 'object') ? d : null;
            ok = true;
            this._arrived('ideas');
        });
        // Le journal vient de gagner une entrée : on le relit APRÈS coup (le
        // callback de _llm n'est pas attendu, on ne lui confie rien d'async).
        if (ok) await this._refreshJournal();
    },

    // Depuis une idée : on ouvre Nouveau trade sur ce titre. C'est LUI qui
    // décide ensuite — le module ne passe aucun ordre tout seul.
    async useIdea(ticker) {
        await this.openTrade(ticker);
    },

    // --- Journal des idées : ce que le coach a DÉJÀ dit, daté ---------------
    //
    // Sans lui, chaque demande d'idées écrasait la précédente à l'écran : on ne
    // pouvait pas revenir sur un pari d'il y a trois jours pour voir ce qu'il
    // valait. Le journal garde la trace des demandes d'idées ET des revues de
    // positions — mêmes entrées, deux genres.

    _journalEntries() {
        const d = this._ideasJournal;
        return (d && Array.isArray(d.entries)) ? d.entries : [];
    },

    // « 26/08 14:07 » — dans un journal, l'année encombre plus qu'elle n'informe.
    _dateShort(v) {
        const dt = this._toDate(v);
        if (!dt) return '—';
        const p = (x) => (x < 10 ? '0' : '') + x;
        return p(dt.getDate()) + '/' + p(dt.getMonth() + 1) + ' ' +
            p(dt.getHours()) + ':' + p(dt.getMinutes());
    },

    _journalKindBadge(kind) {
        const k = String(kind == null ? '' : kind).toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(this._JOURNAL_KINDS, k)) return '';
        return '<span class="badge' + (k === 'review' ? ' warn' : '') + '">' +
            esc(Lang.t(this._JOURNAL_KINDS[k])) + '</span>';
    },

    // Un ticker du journal est un RACCOURCI : un clic ouvre Nouveau trade.
    _journalChip(sym, extra) {
        const t = String(sym == null ? '' : sym);
        if (!t) return '';
        return '<span style="display:inline-flex;gap:5px;align-items:center;">' +
            '<button class="btn btn-ghost btn-sm" data-paper-act="idea-pick" ' +
                'data-sym="' + esc(t) + '" style="' + this._mono + 'font-weight:600;">' +
              esc(t) + '</button>' + (extra || '') +
        '</span>';
    },

    _journalEntry(e) {
        if (!e || typeof e !== 'object') return '';
        const id = String(this._pickField(e, ['id']) || '');
        const open = !!(id && this._journalOpen[id]);
        const text = String(e.text || '');
        const ideas = Array.isArray(e.ideas) ? e.ideas : [];
        const verdicts = Array.isArray(e.verdicts) ? e.verdicts : [];
        const chips = ideas.map((it) => this._journalChip(it && it.ticker))
            .concat(verdicts.map((v) => this._journalChip(v && v.symbol,
                this._stanceBadge(v && v.stance))))
            .filter((x) => !!x).join('');
        // Le niveau n'est affiché que s'il est CONNU : une valeur inattendue ne
        // fabrique ni clé i18n ni badge (whitelist _LEVELS).
        const lv = String(e.risk_level == null ? '' : e.risk_level);
        return '<div class="row" style="display:block;padding:10px 12px;">' +
            '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
              '<span style="' + this._mono + 'font-size:12px;color:var(--text-dim);">' +
                esc(this._dateShort(e.ts)) + '</span>' +
              this._journalKindBadge(e.kind) +
              (this._isLevel(lv)
                ? '<span class="badge">' + esc(Lang.t('paper.level_' + lv)) + '</span>' : '') +
              (text
                ? '<button class="btn btn-ghost btn-sm" data-paper-act="journal-toggle" ' +
                      'data-id="' + esc(id) + '" style="margin-left:auto;">' +
                    esc(Lang.t(open ? 'paper.hide_text' : 'paper.show_text')) + '</button>'
                : '') +
            '</div>' +
            (chips
              ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' + chips + '</div>'
              : '') +
            ((open && text) ? this._panel('', text) : '') +
        '</div>';
    },

    // ⚠️ Les clés paper.journal_* appartiennent à l'onglet Journal (les trades
    // CLOS). Le journal des idées porte donc son propre préfixe ideas_log_ :
    // deux journaux, deux vocabulaires, aucune clé partagée par accident.
    _journalCard() {
        const rows = this._journalEntries();
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.ideas_log_title')) +
                this._muted(Lang.t('paper.ideas_log_empty')));
        }
        return this._card(this._head(Lang.t('paper.ideas_log_title'), Lang.t('paper.ideas_log_hint')) +
            '<div class="row-list">' + rows.map((e) => this._journalEntry(e)).join('') + '</div>');
    },

    toggleJournal(id) {
        const k = String(id || '');
        if (!k) return;
        if (this._journalOpen[k]) delete this._journalOpen[k];
        else this._journalOpen[k] = true;
        if (this._tab === 'coach') this._renderBody();
    },

    async _loadIdeasJournal() {
        const d = await this._get('/api/paper/ideas/journal?limit=20');
        this._ideasJournal = (d && typeof d === 'object') ? d : { entries: [] };
    },

    // Après une génération d'idées ou une revue : le journal a bougé côté
    // serveur, on le relit — même si l'utilisateur est ailleurs (il le
    // retrouvera à jour au retour, sans nouveau clic).
    async _refreshJournal() {
        await this._loadIdeasJournal();
        if (this._tab === 'coach') this._renderBody();
    },

    _analysisCard() {
        return this._card(
            this._head(Lang.t('paper.analysis_title'), Lang.t('paper.analysis_hint')) +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
              '<div style="flex:0 1 220px;">' +
                '<label class="form-label">' + esc(Lang.t('paper.col_symbol')) + '</label>' +
                '<input id="paper-analysis-sym" class="form-input" autocomplete="off" ' +
                     'value="' + esc(this._analysisPrefill || '') + '" ' +
                     'placeholder="' + esc(Lang.t('paper.analysis_symbol_ph')) + '" />' +
              '</div>' +
              '<button class="btn btn-primary" data-paper-act="analysis" data-paper-busy="analysis">' +
                esc(Lang.t('paper.analysis_btn')) + '</button>' +
              '<button class="btn btn-ghost" data-paper-act="watch-add-analysis">' +
                esc(Lang.t('paper.watchlist_add')) + '</button>' +
            '</div>' +
            // Le graphique passe AU-DESSUS du texte : on lit la courbe, puis le commentaire.
            ((this._analysis && this._analysisSymbol)
                ? this._chartCard('analysis', this._analysisSymbol, '') : '') +
            (this._analysis ? this._panel(Lang.t('paper.analysis_title'), this._analysis) : '')
        );
    },

    // --- Carnet : le coach écrit une mémoire LISIBLE (Markdown brut) ---------
    //
    // Rendu volontairement brut : pas de moteur Markdown (aucune dépendance),
    // et surtout aucun HTML issu d'un texte que le LLM a écrit. Le bloc mono
    // Le bloc mono .console du design system fait exactement ce qu'il faut (pre-wrap,
    // fond bleu-nuit invariant au mode clair).

    // Les carnets et les discussions coach sont PARTAGES entre traders ; l'argent
    // et les positions restent prives. La carte a donc deux niveaux : a qui, puis
    // quelle note. Le carnet d'un autre est en lecture seule (le backend aussi).
    _me() {
        try {
            const u = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
            return (u && u.username) ? String(u.username) : '';
        } catch (e) { return ''; }
    },

    // Moi d'abord — c'est mon carnet que j'ouvre le plus souvent —, les autres
    // ensuite dans l'ordre rendu par le backend.
    _communityUsers() {
        const c = this._community;
        const raw = (c && Array.isArray(c.users)) ? c.users
            : (Array.isArray(c) ? c : []);
        const me = this._me();
        const out = [];
        const seen = {};
        raw.forEach((row) => {
            const name = String((row && row.user) || '');
            if (!name || seen[name]) return;
            seen[name] = true;
            out.push({ user: name, notes: (row && Array.isArray(row.notes)) ? row.notes : [] });
        });
        // Mon carnet existe meme si /community n'a pas repondu.
        if (me && !seen[me]) out.unshift({ user: me, notes: this._ownNotes() });
        out.sort((a, b) => (a.user === me ? -1 : (b.user === me ? 1 : 0)));
        return out;
    },

    _ownNotes() {
        const n = this._notes;
        if (Array.isArray(n)) return n;
        if (n && Array.isArray(n.notes)) return n.notes;
        return [];
    },

    _currentOwner() { return this._noteOwner || this._me(); },

    // Pour MOI, la liste fraiche de /coach/notes fait foi ; pour les autres,
    // celle que /community a livree.
    _noteList() {
        const owner = this._currentOwner();
        if (owner && owner === this._me()) {
            const own = this._ownNotes();
            if (own.length) return own;
        }
        const rows = this._communityUsers();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].user === owner) return rows[i].notes;
        }
        return owner === this._me() ? this._ownNotes() : [];
    },

    _notesCard() {
        const me = this._me();
        const owner = this._currentOwner();
        const users = this._communityUsers();
        const pills = users.length > 1
            ? '<div class="paper-tabs" style="margin-bottom:10px;">' + users.map((x) =>
                '<button class="paper-tab' + (x.user === owner ? ' active' : '') + '" ' +
                    'data-paper-act="note-owner" data-owner="' + esc(x.user) + '">' +
                  esc(x.user) +
                  (x.user === me ? ' <span style="font-size:11px;opacity:.75;">' +
                      esc(Lang.t('paper.community_me')) + '</span>' : '') +
                '</button>'
              ).join('') + '</div>'
            : '';
        const rows = this._noteList();
        const list = rows.length
            ? '<div class="row-list">' + rows.map((n) => {
                const name = String((n && n.name) || '');
                const size = this._n(n && n.size);
                const active = (this._noteName === name);
                return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                       'flex-wrap:wrap;padding:8px 12px;cursor:pointer;' +
                       (active ? 'border-color:var(--accent);' : '') + '" ' +
                       'data-paper-act="open-note" data-note="' + esc(name) + '">' +
                    '<span style="flex:1 1 220px;min-width:0;font-size:14px;' + this._mono + '">' +
                      esc(name) + '</span>' +
                    '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                      esc(this._dateTime(n && n.modified)) +
                      (size === null ? '' : ' · ' + esc(this._num(size, 0)) + ' o') +
                    '</span>' +
                '</div>';
            }).join('') + '</div>'
            : this._muted(Lang.t('paper.notes_empty'));
        const body = (this._noteName && this._noteBody !== null)
            ? '<div style="margin-top:12px;">' +
                '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px;' +
                     'flex-wrap:wrap;">' +
                  '<span style="font-size:13px;' + this._mono + 'color:var(--text-muted);">' +
                    esc(owner) + ' · ' + esc(this._noteName) + '</span>' +
                  (owner === me ? '' :
                    '<span class="badge">' + esc(Lang.t('paper.community_readonly')) + '</span>') +
                  '<button class="btn btn-ghost btn-sm" data-paper-act="close-note" ' +
                          'style="margin-left:auto;">' + esc(Lang.t('paper.close')) + '</button>' +
                '</div>' +
                '<pre class="console" style="margin:0;">' + esc(this._noteBody) + '</pre>' +
              '</div>'
            : '';
        return this._card(this._head(Lang.t('paper.community_title'),
                Lang.t('paper.community_hint')) + pills + list + body);
    },

    // Le nom peut contenir des « / » (« Biais/revenge_trade.md ») : on encode
    // CHAQUE segment et on rejoint avec de vrais « / » — un %2F serait décodé
    // par le serveur ASGI avant le routage et ne matcherait plus la route.
    _noteUrl(name, owner) {
        const parts = String(name || '').split('/').filter((x) => x !== '');
        const path = parts.map(encodeURIComponent).join('/');
        if (owner && owner !== this._me()) {
            return '/api/paper/community/' + encodeURIComponent(owner) + '/' + path;
        }
        return '/api/paper/coach/notes/' + path;
    },

    selectNoteOwner(owner) {
        if (!owner) return;
        this._noteOwner = String(owner);
        this._noteName = null;
        this._noteBody = null;
        this._renderBody();
    },

    async openNote(name) {
        if (!name) return;
        if (this._noteName === name && this._noteBody !== null) {
            this._noteName = null; this._noteBody = null; this._renderBody(); return;
        }
        const d = await this._get(this._noteUrl(name, this._currentOwner()));
        if (!d) { this._toast('error', Lang.t('paper.error')); return; }
        this._noteName = String(d.name || name);
        this._noteBody = String(this._pickField(d, ['markdown', 'content', 'text']) || '');
        this._renderBody();
    },

    // =====================================================================
    //  5. LEÇONS
    // =====================================================================

    _lessonList() {
        const l = this._lessons;
        if (Array.isArray(l)) return l;
        if (l && Array.isArray(l.lessons)) return l.lessons;
        if (l && Array.isArray(l.catalog)) return l.catalog;
        return [];
    },

    _viewLessons() {
        if (!this._lessons) return this._card(this._muted(Lang.t('paper.loading')));
        const rows = this._lessonList();
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.lessons_title')) +
                this._muted(Lang.t('paper.lessons_empty')));
        }
        if (this._lessonId !== null) return this._lessonDetail();
        const list = '<div class="row-list">' + rows.map((l) => {
            const id = String(this._pickField(l, ['id', 'slug', 'key']) || '');
            const done = !!(l && (l.passed || l.done || l.completed));
            return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                   'flex-wrap:wrap;padding:10px 12px;cursor:pointer;" ' +
                   'data-paper-act="open-lesson" data-lesson="' + esc(id) + '">' +
                '<span style="flex:1 1 240px;min-width:0;font-size:15px;">' +
                  esc((l && l.title) || id) + '</span>' +
                '<span class="badge' + (done ? ' online' : '') + '">' +
                  esc(done ? Lang.t('paper.lesson_done') : Lang.t('paper.lesson_todo')) + '</span>' +
            '</div>';
        }).join('') + '</div>';
        return this._card(this._head(Lang.t('paper.lessons_title'), Lang.t('paper.lessons_hint')) + list);
    },

    _lesson(id) {
        const rows = this._lessonList();
        for (let i = 0; i < rows.length; i++) {
            const l = rows[i];
            const lid = String(this._pickField(l, ['id', 'slug', 'key']) || '');
            if (lid === String(id)) return l;
        }
        return null;
    },

    _lessonDetail() {
        const l = this._lesson(this._lessonId);
        if (!l) return this._card(this._muted(Lang.t('paper.no_data')));
        const raw = this._pickField(l, ['body', 'content', 'text', 'paragraphs']);
        let paras = [];
        if (Array.isArray(raw)) paras = raw;
        else if (typeof raw === 'string') paras = raw.split(/\n\s*\n/);
        const bodyHtml = paras.filter((x) => String(x).trim() !== '').map((x) =>
            '<p style="font-size:15px;line-height:1.7;margin:0 0 12px;">' + esc(String(x)) + '</p>'
        ).join('');
        return this._card(
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px;">' +
              '<h3 style="margin:0;font-size:19px;">' + esc(l.title || this._lessonId) + '</h3>' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="close-lesson" ' +
                      'style="margin-left:auto;">' + esc(Lang.t('paper.back_to_lessons')) + '</button>' +
            '</div>' +
            (bodyHtml || this._muted(Lang.t('paper.no_data'))) +
            this._quizHtml(l)
        );
    },

    _quizQuestions(l) {
        const q = this._pickField(l, ['quiz', 'questions']);
        if (Array.isArray(q)) return q;
        if (q && Array.isArray(q.questions)) return q.questions;
        return [];
    },

    _quizHtml(l) {
        const qs = this._quizQuestions(l);
        if (!qs.length) return '';
        const res = this._quizResult;
        const correct = (res && Array.isArray(res.correct)) ? res.correct : null;
        const blocks = qs.map((q, qi) => {
            const opts = (q && Array.isArray(q.options)) ? q.options
                : ((q && Array.isArray(q.answers)) ? q.answers : []);
            const good = (correct && correct.length > qi) ? Number(correct[qi]) : null;
            const optHtml = opts.map((o, oi) => {
                const isGood = (good !== null && good === oi);
                return '<label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer;' +
                            'padding:5px 0;font-size:14px;line-height:1.5;' +
                            (isGood ? 'color:var(--accent);' : '') + '">' +
                    '<input type="radio" name="paper-q' + qi + '" class="paper-quiz" ' +
                         'data-q="' + qi + '" value="' + oi + '" ' +
                         (correct ? 'disabled ' : '') +
                         'style="margin-top:3px;accent-color:var(--accent);cursor:pointer;" />' +
                    '<span>' + esc(String(o)) + '</span>' +
                '</label>';
            }).join('');
            const expl = (q && (q.explanation || q.why)) ? String(q.explanation || q.why) : '';
            return '<div style="margin-bottom:14px;">' +
                '<div style="font-size:15px;font-weight:600;margin-bottom:6px;">' +
                  esc(String(this._pickField(q, ['question', 'text', 'title']) || '')) + '</div>' +
                optHtml +
                ((correct && expl)
                    ? '<div style="font-size:13px;color:var(--text-muted);margin-top:6px;' +
                           'line-height:1.55;">' + esc(expl) + '</div>'
                    : '') +
            '</div>';
        }).join('');
        let verdict = '';
        if (res) {
            const passed = !!res.passed;
            verdict = '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;">' +
                '<span class="badge ' + (passed ? 'online' : 'warn') + '">' +
                  esc(passed ? Lang.t('paper.quiz_passed') : Lang.t('paper.quiz_failed')) + '</span>' +
                '<span style="' + this._mono + 'font-size:14px;">' +
                  esc(Lang.t('paper.quiz_score') + ' ' + this._num(this._n(res.score), 0) +
                      ' / ' + this._num(qs.length, 0)) + '</span>' +
                '<span style="font-size:12px;color:var(--text-dim);">' +
                  esc(Lang.t('paper.quiz_correct_answer')) + '</span>' +
            '</div>';
        }
        return this._sub('paper.quiz_title') + blocks +
            (res ? verdict : '<button class="btn btn-primary" data-paper-act="quiz-submit" ' +
                'data-lesson="' + esc(String(this._lessonId)) + '">' +
                esc(Lang.t('paper.quiz_submit')) + '</button>');
    },

    async submitQuiz(id) {
        const l = this._lesson(id);
        if (!l) return;
        const qs = this._quizQuestions(l);
        const answers = new Array(qs.length).fill(-1);
        document.querySelectorAll('#paper-body .paper-quiz').forEach((el) => {
            if (!el.checked) return;
            const qi = parseInt(el.getAttribute('data-q'), 10);
            const oi = parseInt(el.value, 10);
            if (isFinite(qi) && isFinite(oi) && qi >= 0 && qi < answers.length) answers[qi] = oi;
        });
        if (answers.indexOf(-1) >= 0) { this._toast('warn', Lang.t('paper.quiz_answer_all')); return; }
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/lessons/' + encodeURIComponent(String(id)) + '/quiz',
                { method: 'POST', body: JSON.stringify({ answers: answers, lang: this._lang() }) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        this._quizResult = d || {};
        this._toast(this._quizResult.passed ? 'success' : 'warn',
            this._quizResult.passed ? Lang.t('paper.quiz_passed') : Lang.t('paper.quiz_failed'));
        // La progression vit dans le profil coach : on relit le catalogue.
        this._lessons = await this._get(this._withLang('/api/paper/lessons')) || this._lessons;
        if (this._tab === 'lessons') this._renderBody();
    },

    // =====================================================================
    //  6. ARÈNE
    // =====================================================================

    _viewArena() {
        if (!this._arena) return this._card(this._muted(Lang.t('paper.loading')));
        const a = this._arena;
        const ch = this._pickField(a, ['challenge', 'current', 'week']);
        const hist = (a && Array.isArray(a.history)) ? a.history : [];
        let head = '';
        if (!ch || typeof ch !== 'object') {
            head = this._card(this._head(Lang.t('paper.arena_title')) +
                this._muted(Lang.t('paper.arena_none')));
        } else {
            const accepted = !!(a.accepted || ch.accepted);
            const diff = this._pickField(ch, ['difficulty', 'level']);
            head = this._card(
                this._head(Lang.t('paper.arena_title'), Lang.t('paper.arena_hint')) +
                '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
                  '<span style="font-size:18px;font-weight:600;">' +
                    esc(this._pickField(ch, ['title', 'name']) || '') + '</span>' +
                  (diff ? '<span class="badge warn">' + esc(Lang.t('paper.arena_difficulty')) +
                      ' ' + esc(String(diff)) + '</span>' : '') +
                  (accepted ? '<span class="badge online">' +
                      esc(Lang.t('paper.arena_accepted')) + '</span>' : '') +
                '</div>' +
                '<div style="font-size:15px;line-height:1.65;margin-top:8px;">' +
                  esc(this._pickField(ch, ['description', 'desc', 'text']) || '') + '</div>' +
                (accepted ? '' :
                  '<div style="margin-top:12px;">' +
                    '<button class="btn btn-primary" data-paper-act="arena-accept">' +
                      esc(Lang.t('paper.arena_accept')) + '</button>' +
                  '</div>')
            );
        }
        const histHtml = hist.length
            ? '<div class="row-list">' + hist.map((h) => {
                const r = this._n(this._pickField(h, ['r_multiple', 'result_r']));
                return '<div class="row" style="display:flex;gap:12px;align-items:center;' +
                       'flex-wrap:wrap;padding:8px 12px;">' +
                    '<span style="flex:1 1 220px;min-width:0;font-size:14px;">' +
                      esc(this._pickField(h, ['title', 'name', 'challenge']) || '') + '</span>' +
                    '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                      esc(this._date(this._pickField(h, ['week', 'date', 'accepted_at']))) + '</span>' +
                    (r === null ? '' : '<span style="' + this._mono + 'color:' + this._color(r) + ';">' +
                      esc(this._signed(r, 2, ' R')) + '</span>') +
                '</div>';
            }).join('') + '</div>'
            : this._muted(Lang.t('paper.arena_empty'));
        return head + this._card(this._head(Lang.t('paper.arena_history')) + histHtml);
    },

    async acceptArena() {
        let r = null;
        try { r = await Auth.apiCall('/api/paper/arena/accept', { method: 'POST', body: JSON.stringify({}) }); }
        catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._toast('success', Lang.t('paper.arena_accepted'));
        this._arena = await this._get(this._withLang('/api/paper/arena')) || this._arena;
        if (this._tab === 'arena') this._renderBody();
    },


    // --- Remise a zero -------------------------------------------------------
    //
    // Discret, en bas, en tonalite danger : c'est une action rare et definitive.
    // Le sous-texte dit ce qui SURVIT — sinon on n'ose jamais cliquer.
    _resetCard() {
        return this._card(
            '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
              '<div style="flex:1 1 320px;min-width:0;font-size:13px;color:var(--text-dim);' +
                   'line-height:1.5;">' + esc(Lang.t('paper.reset_hint')) + '</div>' +
              '<button class="btn btn-ghost" data-paper-act="reset" ' +
                      'style="color:var(--danger);border-color:var(--danger);">' +
                esc(Lang.t('paper.reset_btn')) + '</button>' +
            '</div>'
        );
    },

    async resetPortfolio() {
        // Double confirmation : une remise a zero efface des trades que le
        // journal ne pourra plus jamais rejouer.
        if (!window.confirm(Lang.t('paper.reset_confirm1'))) return;
        if (!window.confirm(Lang.t('paper.reset_confirm2'))) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/portfolio/reset',
                { method: 'POST', body: JSON.stringify({}) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._toast('success', Lang.t('paper.reset_ok'));
        // Le coach et le carnet survivent cote backend : on les relit plutot
        // que de les vider ici (leurs biais parlent des trades effaces).
        this._coach = null;
        this._tradeIdx = null;
        this._postmortem = null;
        await this._tickAndLoad();
        this._renderBody();
    },

    // =====================================================================
    //  7. GRANDS PORTEFEUILLES (13F)
    // =====================================================================

    // Valeur en dollars, abregee : « 267.4 Md$ ». Le separateur decimal reste
    // celui du reste du module (format suisse) — melanger « , » ici et « . »
    // ailleurs ferait douter d'un chiffre, ce qui est pire qu'inelegant.
    _usd(v) {
        const n = this._n(v);
        if (n === null) return '—';
        const a = Math.abs(n);
        if (a >= 1e9) return this._num(n / 1e9, 1) + ' ' + Lang.t('paper.unit_billion') + '$';
        if (a >= 1e6) return this._num(n / 1e6, 1) + ' ' + Lang.t('paper.unit_million') + '$';
        return this._num(n, 0) + ' $';
    },

    _whaleManagers() {
        const w = this._whales;
        if (Array.isArray(w)) return w;
        if (w && Array.isArray(w.managers)) return w.managers;
        return [];
    },

    _viewWhales() {
        if (!this._whales) return this._card(this._muted(Lang.t('paper.loading')));
        return this._whalesDisclaimer() + this._whalesManagersCard() +
            this._whalesSnapshot() + this._whalesEventsCard();
    },

    // Ligne d'honnetete PERMANENTE : un 13F est vieux de 45 jours et ne montre
    // que les actions US longues. La cacher rendrait la vue trompeuse.
    _whalesDisclaimer() {
        return '<div class="card" style="margin-bottom:14px;border-color:var(--warning);' +
                    'background:var(--bg-elev-2);font-size:14px;line-height:1.5;">' +
            esc(Lang.t('paper.whales_disclaimer')) + '</div>';
    },

    _whalesManagersCard() {
        const rows = this._whaleManagers();
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.whales_managers')) +
                this._muted(Lang.t('paper.whales_empty')));
        }
        const pills = rows.map((m) => {
            const id = String(this._pickField(m, ['id', 'key', 'slug']) || '');
            const active = (this._whaleId === id);
            return '<button class="paper-tab' + (active ? ' active' : '') + '" ' +
                   'data-paper-act="whale-pick" data-whale="' + esc(id) + '">' +
                esc((m && m.label) || id) +
                (m && m.quarter ? ' <span style="font-size:11px;opacity:.75;">' +
                    esc(String(m.quarter)) + '</span>' : '') +
                (m && m.cached ? ' <span style="font-size:11px;opacity:.75;">' +
                    esc(Lang.t('paper.whales_cached')) + '</span>' : '') +
            '</button>';
        }).join('');
        return this._card(this._head(Lang.t('paper.whales_managers')) +
            '<div class="paper-tabs" style="margin-bottom:0;">' + pills + '</div>');
    },

    _whalesSnapshot() {
        if (this._whaleLoading) {
            return this._card(this._muted(Lang.t('paper.whales_loading')));
        }
        if (!this._whaleId) return this._card(this._muted(Lang.t('paper.whales_pick')));
        const d = this._whaleSnap;
        if (!d) return this._card(this._muted(Lang.t('paper.whales_error')));
        const status = String(this._pickField(d, ['status']) || '');
        // « unverified » / « error » : on montre le message, JAMAIS un chiffre
        // dont on ne repond pas.
        if (status === 'unverified' || status === 'error') {
            return this._card('<div style="color:var(--danger);font-size:14px;line-height:1.55;">' +
                esc(Lang.t('paper.whales_error')) + '</div>');
        }
        return this._whalesStats(d) + this._whalesTop(d) + this._whalesMoves(d);
    },

    _whalesStats(d) {
        const q = this._pickField(d, ['quarter']);
        const pq = this._pickField(d, ['prev_quarter']);
        const meta = [];
        if (q) meta.push(Lang.t('paper.whales_quarter') + ' ' + String(q));
        if (pq) meta.push(Lang.t('paper.whales_prev_quarter') + ' ' + String(pq));
        const stale = d.stale
            ? ' <span class="badge warn">' + esc(Lang.t('paper.whales_stale')) + '</span>'
            : '';
        const cell = (labelKey, value, unit) =>
            '<div class="stat-card">' +
              '<div class="label">' + esc(Lang.t(labelKey)) + '</div>' +
              '<div class="value">' + esc(value) +
                (unit ? '<span class="unit">' + esc(unit) + '</span>' : '') + '</div>' +
            '</div>';
        const total = this._n(this._pickField(d, ['total_value_usd', 'total_value']));
        const conc = this._n(this._pickField(d, ['concentration_top10_pct', 'concentration_top10']));
        return '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px;">' +
              (meta.length
                ? '<span style="font-size:13px;color:var(--text-muted);' + this._mono + '">' +
                  esc(meta.join(' · ')) + '</span>' : '') + stale +
            '</div>' +
            '<div class="bento-overview" style="grid-template-columns:repeat(3,1fr);' +
                 'grid-template-rows:auto;margin-bottom:14px;">' +
              cell('paper.whales_total_value', this._usd(total), '') +
              cell('paper.whales_n_positions',
                   this._num(this._n(this._pickField(d, ['n_positions'])), 0), '') +
              cell('paper.whales_concentration', this._num(conc, 1), '%') +
            '</div>';
    },

    // Barres en CSS pur : un div dont la largeur est un pourcentage calcule ici
    // (nombre borne 0-100, jamais une chaine venue du backend). Zero librairie.
    // Les barres sont RELATIVES a la plus grosse ligne — le chiffre imprime, lui,
    // est le vrai pourcentage ; c'est dit dans l'en-tete de section.
    _whalesTop(d) {
        const rows = Array.isArray(d.top) ? d.top.slice(0, 15) : [];
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.whales_top')) +
                this._muted(Lang.t('paper.no_data')));
        }
        let max = 0;
        rows.forEach((r) => { const p = this._n(r && r.pct); if (p !== null && p > max) max = p; });
        const bars = rows.map((r) => {
            const pct = this._n(r && r.pct);
            let w = (max > 0 && pct !== null) ? (pct / max) * 100 : 0;
            if (!isFinite(w) || w < 0) w = 0;
            if (w > 100) w = 100;
            const shares = this._n(r && r.shares);
            const chg = this._moveBadge(r && r.change);
            return '<div class="row" style="display:block;padding:9px 12px;">' +
                '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
                  '<span style="flex:1 1 200px;min-width:0;font-size:14px;">' +
                    esc((r && r.name) || '') + '</span>' + chg +
                  '<span style="' + this._mono + 'font-size:14px;font-weight:600;">' +
                    esc(this._num(pct, 2)) + ' %</span>' +
                  '<span style="' + this._mono + 'font-size:13px;color:var(--text-muted);' +
                       'min-width:96px;text-align:right;">' + esc(this._usd(r && r.value_usd)) + '</span>' +
                  (shares === null ? '' :
                    '<span style="' + this._mono + 'font-size:12px;color:var(--text-dim);">' +
                    esc(this._num(shares, 0) + ' ' + Lang.t('paper.whales_shares')) + '</span>') +
                '</div>' +
                '<div style="height:6px;background:var(--bg-elev-3);border-radius:var(--r-pill);' +
                     'overflow:hidden;margin-top:7px;">' +
                  '<div style="height:100%;width:' + w.toFixed(2) + '%;background:var(--accent);' +
                       'border-radius:var(--r-pill);"></div>' +
                '</div>' +
            '</div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.whales_top'), Lang.t('paper.whales_bars_note')) +
            '<div class="row-list">' + bars + '</div>');
    },

    _moveBadge(change) {
        const c = String(change == null ? '' : change).toLowerCase();
        if (!c) return '';
        if (c === 'new') return '<span class="badge online">' + esc(Lang.t('paper.whales_new')) + '</span>';
        if (c === 'exit') return '<span class="badge danger">' + esc(Lang.t('paper.whales_exit')) + '</span>';
        if (c === 'increased' || c === 'up') {
            return '<span class="badge online">' + esc(Lang.t('paper.whales_increased')) + '</span>';
        }
        if (c === 'decreased' || c === 'down') {
            return '<span class="badge warn">' + esc(Lang.t('paper.whales_decreased')) + '</span>';
        }
        return '<span class="badge">' + esc(String(change)) + '</span>';
    },

    _whalesMoves(d) {
        const m = (d && d.moves && typeof d.moves === 'object') ? d.moves : {};
        const groups = [
            [this._pickField(m, ['new']), 'online', 'paper.whales_new'],
            [m.exits, 'danger', 'paper.whales_exit'],
            [m.increased, 'online', 'paper.whales_increased'],
            [m.decreased, 'warn', 'paper.whales_decreased'],
        ];
        let any = false;
        const blocks = groups.map((g) => {
            const rows = Array.isArray(g[0]) ? g[0] : [];
            if (!rows.length) return '';
            any = true;
            const items = rows.map((x) => {
                const name = (x && typeof x === 'object')
                    ? ((x.name || x.symbol || x.ticker) || '') : x;
                const delta = (x && typeof x === 'object') ? this._n(x.delta_pct) : null;
                return '<div class="row" style="display:flex;gap:10px;align-items:center;' +
                       'flex-wrap:wrap;padding:7px 12px;">' +
                    '<span class="badge ' + g[1] + '">' + esc(Lang.t(g[2])) + '</span>' +
                    '<span style="flex:1 1 200px;min-width:0;font-size:14px;">' +
                      esc(String(name)) + '</span>' +
                    (delta === null ? '' :
                      '<span style="' + this._mono + 'font-size:13px;color:' +
                      this._color(delta) + ';">' + esc(this._signed(delta, 1, '%')) + '</span>') +
                '</div>';
            }).join('');
            return '<div style="margin-bottom:10px;"><div class="row-list">' + items + '</div></div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.whales_moves')) +
            (any ? blocks : this._muted(Lang.t('paper.whales_moves_empty'))));
    },

    _whalesEventsCard() {
        const raw = this._whaleEvents;
        const rows = Array.isArray(raw) ? raw : ((raw && Array.isArray(raw.events)) ? raw.events : []);
        if (!rows.length) {
            return this._card(this._head(Lang.t('paper.whales_events')) +
                this._muted(Lang.t('paper.whales_events_empty')));
        }
        const items = rows.map((e) => {
            return '<div class="row" style="display:flex;gap:10px;align-items:center;' +
                   'flex-wrap:wrap;padding:8px 12px;">' +
                '<span class="badge" style="' + this._mono + '">' +
                  esc((e && e.form) || '') + '</span>' +
                '<span style="flex:1 1 220px;min-width:0;font-size:14px;">' +
                  esc((e && e.label) || (e && e.manager_id) || '') + '</span>' +
                '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(Lang.t('paper.whales_filed') + ' ' + this._date(e && e.filing_date)) + '</span>' +
                '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(this._dateTime(e && e.ts)) + '</span>' +
            '</div>';
        }).join('');
        return this._card(this._head(Lang.t('paper.whales_events')) +
            '<div class="row-list" style="max-height:320px;overflow:auto;">' + items + '</div>');
    },

    // Le fetch SEC a froid est PACE : jusqu'a ~10 s. On pose l'etat de
    // chargement AVANT l'appel et on le retire dans le finally — sinon un echec
    // laisse un loader eternel.
    async openWhale(id, force) {
        if (!id) return;
        if (!force && this._whaleId === id && this._whaleSnap) return;
        this._whaleId = String(id);
        this._whaleSnap = null;
        this._whaleLoading = true;
        if (this._tab === 'whales') this._renderBody();
        try {
            this._whaleSnap = await this._get('/api/paper/whales/' + encodeURIComponent(String(id)));
        } finally {
            this._whaleLoading = false;
            if (this._tab === 'whales') this._renderBody();
        }
    },

    // =====================================================================
    //  8. RADAR
    // =====================================================================

    _viewRadar() {
        if (!this._radar) return this._card(this._muted(Lang.t('paper.loading')));
        return this._radarStats() + this._radarLevels() + this._radarList();
    },

    // Bilan par niveau : une ligne par niveau PRÉSENT dans la réponse, dans
    // l'ordre fixe de _LEVEL_ORDER. C'est la seule façon de voir si le grand
    // frisson tient ses promesses ou s'il ne fait que du bruit — le total seul
    // le noierait dans la masse des paris mesurés.
    _radarLevels() {
        const src = (this._radar && this._radar.stats_by_level &&
                     typeof this._radar.stats_by_level === 'object')
            ? this._radar.stats_by_level : null;
        if (!src) return '';
        const num = (v, color) =>
            '<span style="' + this._mono + 'color:' + color + ';font-size:14px;">' +
              esc(this._num(this._n(v) === null ? 0 : this._n(v), 0)) + '</span>';
        const part = (labelKey, v, color) =>
            '<span style="display:inline-flex;gap:5px;align-items:baseline;">' +
              '<span style="font-size:12px;color:var(--text-dim);">' +
                esc(Lang.t(labelKey)) + '</span>' + num(v, color) +
            '</span>';
        const rows = this._LEVEL_ORDER.map((lv) => {
            if (!Object.prototype.hasOwnProperty.call(src, lv)) return '';
            const s = src[lv];
            if (!s || typeof s !== 'object') return '';
            return '<div class="row" style="display:flex;gap:14px;align-items:baseline;' +
                        'flex-wrap:wrap;padding:8px 12px;">' +
                '<span style="flex:1 1 150px;min-width:0;font-size:14px;">' +
                  esc(Lang.t('paper.level_' + lv)) + '</span>' +
                part('paper.radar_hits', s.hits, 'var(--accent)') +
                part('paper.radar_misses', s.misses, 'var(--danger)') +
                part('paper.radar_unclear', s.unclear, 'var(--text-muted)') +
            '</div>';
        }).join('');
        if (!rows) return '';
        return this._card(this._head(Lang.t('paper.radar_by_level')) +
            '<div class="row-list">' + rows + '</div>');
    },

    _radarStats() {
        const st = (this._radar && this._radar.stats && typeof this._radar.stats === 'object')
            ? this._radar.stats : {};
        const cell = (labelKey, v, color) =>
            '<div class="stat-card">' +
              '<div class="label">' + esc(Lang.t(labelKey)) + '</div>' +
              '<div class="value" style="color:' + color + ';">' +
                esc(this._num(this._n(v), 0)) + '</div>' +
            '</div>';
        return '<div class="bento-overview" style="grid-template-columns:repeat(3,1fr);' +
                    'grid-template-rows:auto;margin-bottom:14px;">' +
              cell('paper.radar_hits', st.hits, 'var(--accent)') +
              cell('paper.radar_misses', st.misses, 'var(--danger)') +
              cell('paper.radar_unclear', st.unclear, 'var(--text-muted)') +
            '</div>' +
            // Phrase permanente : le radar PARIE, il ne sait pas.
            '<div class="card" style="margin-bottom:14px;border-color:var(--warning);' +
                 'background:var(--bg-elev-2);font-size:14px;line-height:1.5;' +
                 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
              '<span style="flex:1 1 320px;min-width:0;">' +
                esc(Lang.t('paper.radar_disclaimer')) + '</span>' +
              '<button class="btn btn-primary" data-paper-act="radar-run" data-paper-busy="radar">' +
                esc(Lang.t('paper.radar_run')) + '</button>' +
            '</div>';
    },

    _radarHypotheses() {
        const r = this._radar;
        if (Array.isArray(r)) return r;
        if (r && Array.isArray(r.hypotheses)) return r.hypotheses;
        return [];
    },

    _confidenceBadge(v) {
        const c = String(v == null ? '' : v).toLowerCase();
        if (!c) return '';
        if (c === 'high' || c === 'haute' || c === 'alta') {
            return '<span class="badge online">' + esc(Lang.t('paper.radar_conf_high')) + '</span>';
        }
        if (c === 'medium' || c === 'moyenne' || c === 'media') {
            return '<span class="badge warn">' + esc(Lang.t('paper.radar_conf_medium')) + '</span>';
        }
        if (c === 'low' || c === 'basse' || c === 'bassa') {
            return '<span class="badge">' + esc(Lang.t('paper.radar_conf_low')) + '</span>';
        }
        return '<span class="badge">' + esc(String(v)) + '</span>';
    },

    _outcomeBadge(o) {
        const c = String(o == null ? '' : o).toLowerCase();
        if (c === 'hit') return '<span class="badge online">' + esc(Lang.t('paper.radar_outcome_hit')) + '</span>';
        if (c === 'miss') return '<span class="badge danger">' + esc(Lang.t('paper.radar_outcome_miss')) + '</span>';
        if (c === 'unclear') return '<span class="badge">' + esc(Lang.t('paper.radar_outcome_unclear')) + '</span>';
        return '';
    },

    _radarList() {
        const rows = this._radarHypotheses();
        if (!rows.length) {
            return this._card(this._muted(Lang.t('paper.radar_empty')));
        }
        // Les hypotheses OUVERTES d'abord : ce sont les seules sur lesquelles on
        // peut encore apprendre quelque chose.
        const open = rows.filter((h) => String((h && h.status) || '') !== 'scored');
        const scored = rows.filter((h) => String((h && h.status) || '') === 'scored');
        return open.concat(scored).map((h) => this._radarCard(h)).join('');
    },

    _radarCard(h) {
        if (!h || typeof h !== 'object') return '';
        const isScored = (String(h.status || '') === 'scored');
        const move = this._n(h.move_pct);
        const list = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
        const chips = (labelKey, arr) => {
            const rows = list(arr);
            if (!rows.length) return '';
            return '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-top:6px;">' +
                '<span style="font-size:12px;color:var(--text-dim);min-width:70px;">' +
                  esc(Lang.t(labelKey)) + '</span>' +
                rows.map((x) => '<span class="badge" style="' + this._mono + '">' +
                    esc(String((x && typeof x === 'object') ? (x.name || x.symbol || '') : x)) +
                    '</span>').join('') +
            '</div>';
        };
        const horizon = this._n(h.horizon_days);
        const meta = [];
        if (h.direction) meta.push(Lang.t('paper.radar_direction') + ' ' + String(h.direction));
        if (horizon !== null) {
            meta.push(Lang.t('paper.radar_horizon') + ' ' + this._num(horizon, 0) + ' ' +
                Lang.t('paper.radar_days'));
        }
        if (h.created_at) meta.push(this._date(h.created_at));
        return this._card(
            '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px;">' +
              '<span style="flex:1 1 260px;min-width:0;font-size:16px;font-weight:600;line-height:1.45;">' +
                esc(h.thesis || '') + '</span>' +
              (isScored ? this._outcomeBadge(h.outcome)
                        : '<span class="badge">' + esc(Lang.t('paper.radar_open')) + '</span>') +
              this._confidenceBadge(h.confidence) +
              ((isScored && move !== null)
                ? '<span style="' + this._mono + 'font-size:15px;font-weight:600;color:' +
                  this._color(move) + ';">' + esc(this._signed(move, 2, '%')) + '</span>' : '') +
            '</div>' +
            (h.chain
              ? '<div style="font-size:14px;line-height:1.6;color:var(--text-muted);">' +
                esc(h.chain) + '</div>' : '') +
            chips('paper.radar_markets', h.markets) +
            chips('paper.radar_tickers', h.tickers) +
            (meta.length
              ? '<div style="font-size:12px;color:var(--text-dim);' + this._mono +
                   'margin-top:8px;">' + esc(meta.join(' · ')) + '</div>' : '') +
            (h.invalidation
              ? '<div style="margin-top:10px;border-left:2px solid var(--warning);padding-left:10px;' +
                     'font-size:13px;line-height:1.55;">' +
                '<span style="color:var(--warning);">' + esc(Lang.t('paper.radar_invalidation')) +
                '</span> : ' + esc(h.invalidation) + '</div>' : '')
        );
    },

    // Jusqu'a ~2 minutes : le bouton DIT qu'il travaille (registre _busy, donc
    // l'attente survit a un changement d'onglet), et il est rendu meme si
    // l'appel echoue (finally).
    async runRadar() {
        if (this._isBusy('radar')) { this._toast('info', Lang.t('paper.busy_wait')); return; }
        this._setBusy('radar', true);
        try {
            let r = null;
            try {
                r = await Auth.apiCall('/api/paper/radar/run',
                    { method: 'POST', body: JSON.stringify({}) });
            } catch (e) { r = null; }
            if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
            let d = null;
            try { d = await r.json(); } catch (e) { d = null; }
            const gen = this._n(d && d.generated);
            const sc = this._n(d && d.scored);
            this._toast('success', Lang.t('paper.radar_ran') + ' : ' +
                this._num(gen === null ? 0 : gen, 0) + ' ' + Lang.t('paper.radar_generated') + ', ' +
                this._num(sc === null ? 0 : sc, 0) + ' ' + Lang.t('paper.radar_scored'));
            this._radar = await this._get('/api/paper/radar') || this._radar;
            if (this._tab === 'radar') this._renderBody();
        } finally {
            this._setBusy('radar', false);
        }
    },


    // =====================================================================
    //  9. PLAN — pipeline d'achats, apprentissage, scénarios
    // =====================================================================
    //
    // Le board de mission du trader : ce que je regarde, ce que j'ai appris,
    // et les chemins que le monde peut prendre. Trois sections, aucune magie.
    //
    // Règle centrale, écrite à l'écran : les colonnes « Ordre placé », « En
    // position » et « Clôturé » sont CALCULÉES depuis le portefeuille. On peut
    // pousser une idée de « À étudier » à « Thèse prête » — pas au-delà : un
    // board qu'on déplace à la main finit toujours par raconter autre chose
    // que ce qui s'est vraiment passé.

    _viewPlan() {
        if (!this._board) return this._card(this._muted(Lang.t('paper.loading')));
        return this._pipelineCard() + this._learningCard() + this._scenariosCard();
    },

    // --- Lectures tolérantes -------------------------------------------------

    _boardPipeline() {
        const b = this._board;
        if (Array.isArray(b)) return b;
        return (b && Array.isArray(b.pipeline)) ? b.pipeline : [];
    },

    _boardScenarios() {
        const b = this._board;
        return (b && Array.isArray(b.scenarios)) ? b.scenarios : [];
    },

    // L'étape EFFECTIVE d'une ligne. Tout ce qui n'est pas une colonne connue
    // retombe sur « À étudier » : une idée mal étiquetée reste visible dans la
    // première colonne plutôt que de disparaître du board.
    _pipeStage(it) {
        const s = String((it && it.computed_stage) || '');
        return (this._PIPE_STAGES.indexOf(s) >= 0) ? s : 'etude';
    },

    _pipeStageLabel(stage) {
        return (this._PIPE_STAGES.indexOf(stage) >= 0)
            ? Lang.t('paper.stage_' + stage) : String(stage || '');
    },

    // Une thèse tient en une ligne dans la carte ; le texte entier vit dans le
    // title (survol) — on ne coupe jamais l'information, on la range.
    _clip(txt, max) {
        const s = String(txt == null ? '' : txt);
        const n = max || 96;
        return (s.length <= n) ? s : (s.slice(0, n - 1) + '…');
    },

    // --- Section 1 : pipeline d'achats --------------------------------------

    _pipeCardHtml(it) {
        const stage = this._pipeStage(it);
        const id = String((it && it.id) || '');
        const symbol = String((it && it.symbol) || '');
        const name = String((it && it.name) || '');
        const thesis = String((it && it.thesis) || '');
        const fromCoach = (String((it && it.source) || '') === 'coach');
        const lastR = (stage === 'clos') ? this._n(it && it.last_r) : null;
        const manual = Object.prototype.hasOwnProperty.call(this._PIPE_MANUAL, stage);
        const next = manual ? this._PIPE_NEXT[stage] : '';

        // Le verrou est DIT, pas seulement subi : sans lui, l'absence de bouton
        // passerait pour un oubli d'interface.
        const lock = manual ? ''
            : '<span class="badge muted" title="' + esc(Lang.t('paper.plan_locked_hint')) + '">' +
              esc(Lang.t('paper.plan_locked')) + '</span>';

        const move = (manual && id && next)
            ? '<button class="btn btn-ghost btn-sm" data-paper-act="plan-stage" ' +
                  'data-id="' + esc(id) + '" data-stage="' + esc(next) + '">' +
              esc(Lang.t('paper.plan_move_' + next)) + '</button>'
            : '';

        return '<div class="paper-pipe-card">' +
            '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">' +
              '<span style="' + this._mono + 'font-size:14px;font-weight:600;">' +
                esc(symbol) + '</span>' +
              '<span class="badge ' + (fromCoach ? 'online' : 'muted') + '">' +
                esc(Lang.t(fromCoach ? 'paper.plan_src_coach' : 'paper.plan_src_me')) + '</span>' +
              lock +
              ((lastR === null) ? ''
                : '<span style="' + this._mono + 'font-size:13px;font-weight:600;margin-left:auto;' +
                       'color:' + this._color(lastR) + ';">' +
                  esc(this._signed(lastR, 2, ' R')) + '</span>') +
            '</div>' +
            (name
              ? '<div style="font-size:13px;color:var(--text-muted);margin-top:4px;' +
                     'overflow-wrap:anywhere;">' + esc(name) + '</div>' : '') +
            (thesis
              ? '<div style="font-size:13px;line-height:1.5;margin-top:6px;color:var(--text);' +
                     'overflow-wrap:anywhere;" title="' + esc(thesis) + '">' +
                esc(this._clip(thesis, 96)) + '</div>' : '') +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' +
              move +
              (symbol
                ? '<button class="btn btn-sm" data-paper-act="plan-trade" ' +
                      'data-sym="' + esc(symbol) + '">' +
                  esc(Lang.t('paper.watchlist_trade')) + '</button>' : '') +
              (id
                ? '<button class="btn btn-ghost btn-sm" data-paper-act="plan-del" ' +
                      'data-id="' + esc(id) + '" style="color:var(--danger);">' +
                  esc(Lang.t('paper.watchlist_remove')) + '</button>' : '') +
            '</div>' +
        '</div>';
    },

    _pipelineCard() {
        const rows = this._boardPipeline();
        const cols = this._PIPE_STAGES.map((stage) => {
            const items = rows.filter((it) => this._pipeStage(it) === stage);
            const cards = items.length
                ? items.map((it) => this._pipeCardHtml(it)).join('')
                : '<div style="font-size:12px;color:var(--text-dim);padding:6px 2px;">' +
                  esc(Lang.t('paper.plan_col_empty')) + '</div>';
            return '<div class="paper-pipe-col">' +
                '<div class="paper-pipe-head">' +
                  '<span>' + esc(this._pipeStageLabel(stage)) + '</span>' +
                  '<span style="' + this._mono + '">' + esc(String(items.length)) + '</span>' +
                '</div>' + cards +
            '</div>';
        }).join('');

        // Le formulaire d'ajout vit EN HAUT : une idée se note quand elle
        // arrive, pas après avoir fait défiler cinq colonnes.
        const form =
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px;">' +
              '<div style="flex:0 1 180px;">' +
                '<label class="form-label" for="paper-plan-sym">' +
                  esc(Lang.t('paper.col_symbol')) + '</label>' +
                '<input id="paper-plan-sym" class="form-input" autocomplete="off" ' +
                     'placeholder="' + esc(Lang.t('paper.analysis_symbol_ph')) + '" />' +
              '</div>' +
              '<div style="flex:1 1 280px;min-width:0;">' +
                '<label class="form-label" for="paper-plan-thesis">' +
                  esc(Lang.t('paper.plan_thesis_label')) + '</label>' +
                '<input id="paper-plan-thesis" class="form-input" autocomplete="off" ' +
                     'placeholder="' + esc(Lang.t('paper.plan_thesis_ph')) + '" />' +
              '</div>' +
              '<button class="btn btn-primary" data-paper-act="plan-add">' +
                esc(Lang.t('paper.plan_add')) + '</button>' +
            '</div>';

        return this._card(
            this._head(Lang.t('paper.plan_pipeline_title'), Lang.t('paper.plan_pipeline_hint')) +
            form +
            '<div style="font-size:13px;color:var(--text-muted);line-height:1.5;margin-bottom:12px;">' +
              esc(Lang.t('paper.plan_derived_note')) + '</div>' +
            '<div class="paper-pipe">' + cols + '</div>'
        );
    },

    async addPipeline() {
        const si = document.getElementById('paper-plan-sym');
        const ti = document.getElementById('paper-plan-thesis');
        const sym = si ? String(si.value || '').trim() : '';
        if (!sym) { this._toast('warn', Lang.t('paper.symbol_required')); return; }
        const body = { symbol: sym };
        const th = ti ? String(ti.value || '').trim() : '';
        if (th) body.thesis = th;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/board/pipeline',
                { method: 'POST', body: JSON.stringify(body) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        // Un doublon n'est pas une erreur : la ligne existait déjà, on le DIT
        // au lieu de laisser croire à un deuxième ajout.
        this._toast(d && d.duplicate ? 'info' : 'success',
            Lang.t(d && d.duplicate ? 'paper.plan_dup' : 'paper.plan_added') + ' ' + sym);
        this._board = await this._get('/api/paper/board') || this._board;
        if (this._tab === 'plan') this._renderBody();
    },

    async setPipelineStage(id, stage) {
        // Rien de forgé ne part vers le backend : seules les deux colonnes
        // manuelles sont acceptées ici.
        if (!id || !Object.prototype.hasOwnProperty.call(this._PIPE_MANUAL, String(stage))) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/board/pipeline/' + encodeURIComponent(String(id)),
                { method: 'POST', body: JSON.stringify({ stage_manual: String(stage) }) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._board = await this._get('/api/paper/board') || this._board;
        if (this._tab === 'plan') this._renderBody();
    },

    async removePipeline(id) {
        if (!id) return;
        if (!window.confirm(Lang.t('paper.plan_del_confirm'))) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/board/pipeline/' + encodeURIComponent(String(id)),
                { method: 'DELETE' });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._board = await this._get('/api/paper/board') || this._board;
        if (this._tab === 'plan') this._renderBody();
    },

    // --- Section 2 : apprentissage ------------------------------------------

    // Une barre = une fraction lisible. La largeur est un NOMBRE borné 0-100
    // calculé ici, jamais une chaîne venue du backend (même doctrine que les
    // barres 13F).
    _learnBar(labelKey, done, total) {
        const d = this._n(done);
        const t = this._n(total);
        const dv = (d === null || d < 0) ? 0 : d;
        const tv = (t === null || t < 0) ? 0 : t;
        let w = (tv > 0) ? (dv / tv) * 100 : 0;
        if (!isFinite(w) || w < 0) w = 0;
        if (w > 100) w = 100;
        return '<div style="margin-bottom:12px;">' +
            '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
              '<span style="flex:1 1 200px;min-width:0;font-size:14px;">' +
                esc(Lang.t(labelKey)) + '</span>' +
              '<span style="' + this._mono + 'font-size:14px;font-weight:600;">' +
                esc(this._num(dv, 0) + ' / ' + this._num(tv, 0)) + '</span>' +
            '</div>' +
            '<div style="height:6px;background:var(--bg-elev-3);border-radius:var(--r-pill);' +
                 'overflow:hidden;margin-top:7px;">' +
              '<div style="height:100%;width:' + w.toFixed(2) + '%;background:var(--accent);' +
                   'border-radius:var(--r-pill);"></div>' +
            '</div>' +
        '</div>';
    },

    // Le backend range les étapes en objets « {key, reached_at} » (elles portent
    // leur date), mais une liste de codes nus reste lisible : on accepte les
    // deux formes plutôt que d'afficher « [object Object] ».
    _milestoneCode(x) {
        if (x && typeof x === 'object') {
            const v = this._pickField(x, ['key', 'code', 'id']);
            return v ? String(v) : '';
        }
        return String(x == null ? '' : x);
    },

    // Un code d'étape inconnu s'affiche BRUT (échappé) : on ne fabrique pas de
    // clé i18n à partir d'une chaîne étrangère, et on ne cache pas un acquis.
    _milestoneLabel(code) {
        const c = this._milestoneCode(code);
        if (!Object.prototype.hasOwnProperty.call(this._MILESTONES, c)) return c;
        return this._label('paper.milestone_' + c, c);
    },

    _learningCard() {
        const b = this._board || {};
        const l = (b.learning && typeof b.learning === 'object') ? b.learning : {};
        const les = (l.lessons && typeof l.lessons === 'object') ? l.lessons : {};
        const ar = (l.arena && typeof l.arena === 'object') ? l.arena : {};
        const bi = (l.biases && typeof l.biases === 'object') ? l.biases : {};

        // Biais : le total, c'est TOUT ce qui a été repéré — résolus compris.
        // Rapporter les résolus aux seuls actifs ferait une barre qui recule
        // quand on progresse.
        const resolved = this._n(bi.resolved);
        const active = this._n(bi.active);
        const biTotal = (resolved === null ? 0 : resolved) + (active === null ? 0 : active);

        // Une étape sans code exploitable est écartée : un badge vide ne dit rien.
        const codes = (Array.isArray(l.milestones) ? l.milestones : [])
            .filter((c) => this._milestoneCode(c) !== '');
        const chips = codes.length
            ? this._sub('paper.milestones') +
              '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
              codes.map((c) => '<span class="badge online">' +
                  esc(this._milestoneLabel(c)) + '</span>').join('') + '</div>'
            : '';

        const exp = this._n(l.expectancy_r);
        const stats =
            '<div class="bento-overview" style="grid-template-columns:repeat(2,1fr);' +
                 'grid-template-rows:auto;margin:14px 0 0;">' +
              '<div class="stat-card">' +
                '<div class="label">' + esc(Lang.t('paper.plan_n_trades')) + '</div>' +
                '<div class="value">' + esc(this._num(this._n(l.n_trades), 0)) + '</div>' +
              '</div>' +
              '<div class="stat-card">' +
                '<div class="label">' + esc(Lang.t('paper.plan_expectancy')) + '</div>' +
                '<div class="value" style="color:' + this._color(exp) + ';">' +
                  esc(this._signed(exp, 2, '')) + '<span class="unit">R</span></div>' +
              '</div>' +
            '</div>';

        return this._card(
            this._head(Lang.t('paper.plan_learning_title'), Lang.t('paper.plan_learning_hint')) +
            this._learnBar('paper.plan_bar_lessons', les.passed, les.total) +
            this._learnBar('paper.plan_bar_arena', ar.done, ar.accepted) +
            this._learnBar('paper.plan_bar_biases', bi.resolved, biTotal) +
            chips + stats
        );
    },

    // --- Section 3 : scénarios du coach -------------------------------------

    // La flèche est un CARACTÈRE, pas une image ni un emoji, et elle porte son
    // sens en title : la couleur seule ne suffit jamais à dire une direction.
    _playArrow(direction) {
        const cls = this._direction(direction);
        if (cls === 'online') {
            return '<span style="color:var(--accent);" title="' + esc(String(direction)) + '">↑</span>';
        }
        if (cls === 'danger') {
            return '<span style="color:var(--danger);" title="' + esc(String(direction)) + '">↓</span>';
        }
        return '';
    },

    _probBadge(p) {
        const v = String(p == null ? '' : p).toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(this._SCN_PROBS, v)) return '';
        const cls = this._SCN_PROBS[v];
        return '<span class="badge' + (cls ? ' ' + cls : '') + '">' +
            esc(Lang.t('paper.prob_' + v)) + '</span>';
    },

    _branchStatusHtml(treeId, br) {
        const st = String((br && br.status) || '').toLowerCase();
        const bid = String((br && br.id) || '');
        if (Object.prototype.hasOwnProperty.call(this._SCN_STATUS, st)) {
            const strike = (st === 'invalidated') ? 'text-decoration:line-through;' : '';
            return '<span class="badge ' + this._SCN_STATUS[st] + '" style="' + strike + '">' +
                esc(Lang.t('paper.branch_' + st)) + '</span>';
        }
        // Tout le reste (« open » et l'inconnu) est encore à trancher.
        if (!treeId || !bid) return '';
        return '<span style="display:inline-flex;gap:6px;flex-wrap:wrap;">' +
            '<button class="btn btn-ghost btn-sm" data-paper-act="plan-branch" ' +
                'data-tree="' + esc(treeId) + '" data-branch="' + esc(bid) + '" ' +
                'data-status="happened">' + esc(Lang.t('paper.branch_happened')) + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-paper-act="plan-branch" ' +
                'data-tree="' + esc(treeId) + '" data-branch="' + esc(bid) + '" ' +
                'data-status="invalidated">' + esc(Lang.t('paper.branch_invalidated')) + '</button>' +
        '</span>';
    },

    // Profondeur bornée à 2 (0 et 1) : au-delà on n'anticipe plus, on rêve.
    _branchHtml(treeId, br, depth) {
        if (!br || typeof br !== 'object') return '';
        const d = depth || 0;
        const plays = Array.isArray(br.plays) ? br.plays : [];
        const playHtml = plays.map((p) => {
            const tk = String((p && p.ticker) || '');
            if (!tk) return '';
            return '<span style="display:inline-flex;gap:4px;align-items:center;">' +
                '<button class="btn btn-ghost btn-sm" data-paper-act="plan-trade" ' +
                    'data-sym="' + esc(tk) + '" style="' + this._mono + 'font-weight:600;">' +
                  esc(tk) + '</button>' + this._playArrow(p && p.direction) +
            '</span>';
        }).join('');
        const kids = (d < 1 && Array.isArray(br.children))
            ? br.children.map((c) => this._branchHtml(treeId, c, d + 1)).join('') : '';
        return '<div style="border-left:2px solid var(--border-strong);padding-left:12px;' +
                    'margin:10px 0 0 ' + (d ? '12px' : '0') + ';">' +
            '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;">' +
              '<span style="flex:1 1 220px;min-width:0;font-size:14px;font-weight:600;' +
                   'line-height:1.5;overflow-wrap:anywhere;">' +
                esc(String(br.label || '')) + '</span>' +
              this._probBadge(br.prob) +
              this._branchStatusHtml(treeId, br) +
            '</div>' +
            (br.consequence
              ? '<div style="font-size:13px;line-height:1.55;color:var(--text-muted);' +
                     'margin-top:5px;overflow-wrap:anywhere;">' +
                esc(String(br.consequence)) + '</div>' : '') +
            (playHtml
              ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px;">' +
                '<span style="font-size:12px;color:var(--text-dim);">' +
                  esc(Lang.t('paper.plan_plays')) + '</span>' + playHtml + '</div>' : '') +
            kids +
        '</div>';
    },

    _treeHtml(t) {
        if (!t || typeof t !== 'object') return '';
        const id = String(t.id || '');
        const branches = Array.isArray(t.branches) ? t.branches : [];
        return this._card(
            '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
              '<span style="flex:1 1 240px;min-width:0;font-size:16px;font-weight:600;' +
                   'line-height:1.45;overflow-wrap:anywhere;">' +
                esc(String(t.title || '')) + '</span>' +
              (t.updated_at
                ? '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(this._date(t.updated_at)) + '</span>' : '') +
              (id
                ? '<button class="btn btn-ghost btn-sm" data-paper-act="plan-scn-del" ' +
                      'data-tree="' + esc(id) + '">' +
                  esc(Lang.t('paper.plan_scn_archive')) + '</button>' : '') +
            '</div>' +
            (t.context
              ? '<div style="font-size:14px;line-height:1.6;color:var(--text-muted);margin-top:6px;' +
                     'overflow-wrap:anywhere;">' + esc(String(t.context)) + '</div>' : '') +
            (branches.length
              ? branches.map((b) => this._branchHtml(id, b, 0)).join('')
              : this._muted(Lang.t('paper.plan_scn_no_branch')))
        );
    },

    _scenariosCard() {
        const trees = this._boardScenarios();
        const active = trees.filter((t) => String((t && t.status) || 'active') !== 'archived');
        const archived = trees.filter((t) => String((t && t.status) || '') === 'archived');

        const archHtml = archived.length
            ? this._card(
                '<button class="btn btn-ghost btn-sm" data-paper-act="plan-arch">' +
                  esc(Lang.t(this._planArchOpen
                      ? 'paper.plan_scn_hide_archived' : 'paper.plan_scn_show_archived')) +
                  ' (' + esc(String(archived.length)) + ')' +
                '</button>') +
              (this._planArchOpen ? archived.map((t) => this._treeHtml(t)).join('') : '')
            : '';

        const head = this._card(
            this._head(Lang.t('paper.plan_scn_title'), Lang.t('paper.plan_scn_hint')) +
            '<div style="font-size:13px;color:var(--text-muted);line-height:1.5;margin-bottom:10px;">' +
              esc(Lang.t('paper.plan_scn_honesty')) + '</div>' +
            '<button class="btn btn-primary" data-paper-act="plan-scn-gen" data-paper-busy="scenarios">' +
              esc(Lang.t('paper.plan_scn_gen')) + '</button>' +
            (this._scenarioText
              ? this._panel(Lang.t('paper.plan_scn_title'), this._scenarioText) : '')
        );

        const body = active.length
            ? active.map((t) => this._treeHtml(t)).join('')
            : this._card(this._muted(Lang.t('paper.plan_scn_empty')));

        return head + body + archHtml;
    },

    async generateScenarios() {
        // _llm n'attend PAS son callback : on ne lui confie donc que du travail
        // synchrone, et la relecture du board se fait ici, après coup — sinon la
        // promesse du GET flotterait pendant que le bouton se croit fini.
        let ok = false;
        await this._llm('scenarios', '/api/paper/board/scenarios/generate', { lang: this._lang() }, (d) => {
            this._scenarioText = this._llmText(d);
            ok = true;
        });
        if (!ok) { return; }
        if (this._tab !== 'plan') this._toast('success', Lang.t('paper.ready_scenarios'));
        if (!ok) return;
        // L'arbre rendu par l'appel est déjà persisté côté backend : on relit le
        // board plutôt que de le greffer à la main — la liste affichée reste
        // celle du serveur, jamais une copie locale.
        this._board = await this._get('/api/paper/board') || this._board;
        if (this._tab === 'plan') this._renderBody();
    },

    async resolveBranch(treeId, branchId, status) {
        const st = String(status || '');
        if (!treeId || !branchId) return;
        if (!Object.prototype.hasOwnProperty.call(this._SCN_STATUS, st)) return;
        if (!window.confirm(Lang.t('paper.branch_confirm_' + st))) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/board/scenarios/' +
                    encodeURIComponent(String(treeId)) + '/branches/' +
                    encodeURIComponent(String(branchId)),
                { method: 'POST', body: JSON.stringify({ status: st }) });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._board = await this._get('/api/paper/board') || this._board;
        if (this._tab === 'plan') this._renderBody();
    },

    // « Archiver » passe par le DELETE du contrat, mais le backend ne supprime
    // RIEN : il bascule l'arbre en « archived », d'où sa réapparition sous le
    // repli des archivés. La confirmation dit donc « il passe aux archivés »,
    // pas « il disparaît » — on garde la trace de ce qu'on avait imaginé.
    async deleteScenario(treeId) {
        if (!treeId) return;
        if (!window.confirm(Lang.t('paper.plan_scn_del_confirm'))) return;
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/board/scenarios/' +
                    encodeURIComponent(String(treeId)), { method: 'DELETE' });
        } catch (e) { r = null; }
        if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
        this._board = await this._get('/api/paper/board') || this._board;
        if (this._tab === 'plan') this._renderBody();
    },

    // =====================================================================
    //  10. CONNEXIONS — la toile de ce que le module a retenu
    // =====================================================================
    //
    // Une seule question a l'ecran : « qu'est-ce qui touche a ce titre ? ».
    // Les titres (position, favori, pipeline) sont les ANCRES ; tout ce que
    // les guetteurs ont ramasse — presse, catalyseur, hypothese du radar,
    // mouvement de gerant, decor mondial — se range autour de la sienne.
    //
    // Canvas 2D pur, aucune librairie, aucun CDN (meme patron que les bougies :
    // densite de pixels honoree, tokens relus a CHAQUE trace donc dark et clair
    // « Givre » sortent justes tous les deux).
    //
    // Disposition en RAMIFICATION, DETERMINISTE, PAS de simulation physique :
    // deux rendus des memes donnees donnent exactement la meme image. Une toile
    // qui fremit a chaque repeint empeche de reconnaitre ce qu'on regardait —
    // et rend le survol impossible a viser.
    //
    //   * vue globale = une FORET : chaque titre est un tronc pose sur une
    //     ligne de base, chaque tronc pousse des rameaux PAR FAMILLE DE SOURCE
    //     (presse, politique, crypto, social, gerants, radar) et les infos sont
    //     les feuilles au bout du rameau ;
    //   * vue rapprochee = un ARBRE couche, lu de gauche a droite : le titre en
    //     tronc, les familles en branches maitresses, les items dates en
    //     feuilles. C'est la vue « tout ce que le systeme sait sur CE trade ».
    //
    // TROIS bosquets ne pendent a AUCUN tronc, et ne doivent donc jamais s'y
    // greffer : le « monde » (macro sans titre nomme, coin haut gauche), la
    // « foule » (tendances Reddit, coin haut droit) et le « radar » (hypotheses
    // sans titre nomme, sous la ligne de base). Chacun est reconnu PAR SA
    // FORME — un pivot contexte dont les satellites sont tous d'une seule sorte
    // — jamais par son identifiant : le jour ou le serveur y accroche autre
    // chose, il redevient un bosquet ordinaire sans qu'on ait a y toucher.
    //
    // Chaque bosquet est plafonne a douze items par le SERVEUR, qui envoie en
    // plus un noeud AGREGAT (« +67 autres ») accroche au pivot. Douze items,
    // c'est peu : chacun peut donc porter son nom. C'est tout l'objet de cette
    // forme — un arc de douze points anonymes ne disait rien de ce qu'il
    // contenait (retour utilisateur, capture a l'appui : « il y a que ca »).

    _isGraphType(t) {
        return Object.prototype.hasOwnProperty.call(this._GNODE,
            String(t == null ? '' : t).toLowerCase());
    },

    _gtype(t) { return String(t == null ? '' : t).toLowerCase(); },

    _isAnchorType(t) {
        return Object.prototype.hasOwnProperty.call(this._GANCHOR, this._gtype(t));
    },

    // Couleur d'un type de noeud. Type hors table -> --text-dim (pastille
    // neutre) : rien n'est fabrique par concatenation depuis la donnee.
    // Un token vide (feuille de style pas encore la) tombe sur une couleur
    // litterale : une chaine vide passee a fillStyle laisserait le trace de la
    // couleur PRECEDENTE, donc un noeud de la mauvaise couleur.
    _gcolor(t) {
        const k = this._gtype(t);
        const d = this._isGraphType(k) ? this._GNODE[k] : null;
        return this._tok(d ? d[1] : '--text-dim') || '#8FA3C4';
    },

    // Famille de SOURCE d'un type. Type hors table -> « other » : il existe, il
    // se range, mais il ne prend le nom d'aucune famille connue.
    _gfam(t) {
        const k = this._gtype(t);
        if (!this._isGraphType(k)) return 'other';
        return this._GNODE[k][2] || '';
    },

    _isFam(f) {
        return Object.prototype.hasOwnProperty.call(this._GFAM,
            String(f == null ? '' : f));
    },

    _gfamColor(f) {
        const k = String(f == null ? '' : f);
        return this._tok(this._isFam(k) ? this._GFAM[k][1] : '--text-dim') || '#8FA3C4';
    },

    _gfamLabel(f) {
        const k = String(f == null ? '' : f);
        return this._isFam(k) ? Lang.t(this._GFAM[k][0]) : k;
    },

    // Libelle du type. Hors table : chaine vide — on n'invente pas de nom, le
    // noeud garde son propre libelle et c'est tout.
    _gtypeLabel(t) {
        const k = this._gtype(t);
        return this._isGraphType(k) ? Lang.t(this._GNODE[k][0]) : '';
    },

    // --------------------------------------------------------------- donnees

    async loadGraph(symbol) {
        const sym = (symbol === null || symbol === undefined || symbol === '') ? null : String(symbol);
        this._graphSymbol = sym;
        // Un bosquet déplié se lit dans la toile DÉJÀ chargée ; toute requête
        // repart donc de l'index, sinon on afficherait l'arbre d'un bosquet
        // par-dessus les données d'un autre titre.
        this._graphPivot = null;
        this._closeGrove();
        this._graphLoading = true;
        this._graphHover = null;
        if (this._tab === 'graph') this._renderBody();
        const url = '/api/paper/graph' + (sym ? ('?symbol=' + encodeURIComponent(sym)) : '');
        const d = await this._get(url);
        // Deux pastilles cliquees coup sur coup : les reponses peuvent revenir
        // dans le desordre. Celle qui n'est plus celle qu'on regarde est jetee,
        // sinon on afficherait la toile d'un titre sous le nom d'un autre.
        if (this._graphSymbol !== sym) return;
        this._graphLoading = false;
        this._graph = (d && typeof d === 'object') ? d : null;
        this._noteAnchors();
        if (this._tab === 'graph') this._renderBody();
    },

    // La rangee de pills doit survivre au mode ego : une fois rapproche sur un
    // titre, la toile ne contient plus que LUI — sans cette memoire, la rangee
    // se reduirait a une seule pastille et on ne pourrait plus sauter d'un
    // titre a l'autre sans repasser par « Tout ».
    _noteAnchors() {
        const nodes = this._graphNodes();
        if (!this._graphSymbol) {
            const seen = {};
            const out = [];
            nodes.forEach((n) => {
                if (!this._isAnchorType(n.type)) return;
                const id = String(n.id);
                if (seen[id]) return;
                seen[id] = 1;
                out.push({ id: id, label: String(n.label || n.id), type: this._gtype(n.type) });
            });
            out.sort((a, b) => (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
            this._graphAnchors = out;
            return;
        }
        // Arrive directement en vue rapprochee (par le chip d'un graphique) :
        // la rangee n'a jamais ete relevee, on y met au moins ce titre.
        const cur = String(this._graphSymbol);
        for (let i = 0; i < this._graphAnchors.length; i++) {
            if (this._graphAnchors[i].id === cur) return;
        }
        let lab = cur, ty = 'position';
        nodes.forEach((n) => {
            if (String(n.id) !== cur) return;
            lab = String(n.label || cur);
            ty = this._gtype(n.type);
        });
        this._graphAnchors = this._graphAnchors.concat([{ id: cur, label: lab, type: ty }])
            .sort((a, b) => (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
    },

    _graphNodes() {
        const g = this._graph;
        return (g && Array.isArray(g.nodes)) ? g.nodes.filter((n) => n && n.id !== undefined
            && n.id !== null && String(n.id) !== '') : [];
    },

    _graphEdges() {
        const g = this._graph;
        return (g && Array.isArray(g.edges)) ? g.edges.filter((e) => e && e.source && e.target) : [];
    },

    _graphTs(n) {
        const d = this._toDate(n && n.ts);
        return d ? d.getTime() : 0;
    },

    // Le sujet DÉPLIÉ, s'il y en a un : un titre (venu du serveur) ou un
    // bosquet (déplié sur place, sans requête). Vide = l'index.
    _graphRootId() {
        const p = this._graphPivot, s = this._graphSymbol;
        if (p !== null && p !== undefined && p !== '') return String(p);
        if (s !== null && s !== undefined && s !== '') return String(s);
        return '';
    },

    // =====================================================================
    //  Disposition — deterministe de bout en bout
    // =====================================================================
    //
    // AUCUN plafond de dessin ici. La vue globale ne dessine plus que des
    // troncs et trois cartes (le nombre de titres suivis est petit par nature),
    // et un arbre deplie ne concerne qu'UN sujet — le serveur en borne deja le
    // cortege. Un plafond cote client mutilerait surtout les COMPTEURS, qui se
    // lisent sur la totalite des aretes.

    _graphBuild(cssW, cssH) {
        // Un BOSQUET se lit PAR NIVEAUX, sur sa liste entiere — pas sur les
        // douze satellites que la toile en a rapportes. Un pivot que la
        // whitelist ne reconnait pas retombe sur l'arbre couche : c'est le
        // repli, pas un cas mort.
        if (this._groveKindOf(this._graphPivot)) {
            const dr = this._layoutDrill();
            if (!dr || !dr.nodes.length) return null;
            return this._graphFit(dr, cssW, cssH);
        }
        const nodes = this._graphNodes();
        if (!nodes.length) return null;
        const raw = this._graphRootId()
            ? this._layoutTree(nodes)            // sujet deplie : l'arbre couche
            : this._layoutIndex(nodes, cssW);    // vue globale : l'index
        if (!raw || !raw.nodes.length) return null;
        return this._graphFit(raw, cssW, cssH);
    },

    // Decoupe commune aux deux dispositions. TOUT y est trie par une cle
    // TOTALE (dernier departage : l'identifiant) — c'est ce qui garantit que
    // deux rendus des memes donnees rendent exactement la meme image, quel que
    // soit l'ordre dans lequel le backend a range ses listes.
    //
    // Les cles composees sont jointes par un OCTET NUL (echappe, donc visible
    // dans la source) : un symbole peut contenir un point, un tiret ou une
    // espace, jamais un octet nul — deux couples differents ne peuvent donc pas
    // se confondre en une seule cle.
    _graphParts(nodes) {
        const byId = {};
        nodes.forEach((n) => { byId[String(n.id)] = n; });

        // Aretes restreintes aux noeuds REELLEMENT gardes : une arete vers un
        // noeud coupe par le plafond ne doit rattacher personne.
        const edges = this._graphEdges().filter((e) =>
            Object.prototype.hasOwnProperty.call(byId, String(e.source)) &&
            Object.prototype.hasOwnProperty.call(byId, String(e.target)));
        edges.sort((a, b) => {
            const ka = String(a.source) + '\u0000' + String(a.target) + '\u0000' + String(a.type);
            const kb = String(b.source) + '\u0000' + String(b.target) + '\u0000' + String(b.type);
            return ka < kb ? -1 : (ka > kb ? 1 : 0);
        });

        const isAnchor = {}, isPivot = {}, isTheme = {};
        const anchors = [], infos = [], trends = [], pivots = [], aggs = [];
        const themeNodes = [];
        const typeOf = {};
        nodes.forEach((n) => {
            const id = String(n.id), t = this._gtype(n.type);
            typeOf[id] = t;
            if (this._isAnchorType(t)) { isAnchor[id] = 1; anchors.push(n); return; }
            if (t === 'context') { isPivot[id] = 1; pivots.push(n); return; }
            if (t === 'theme') { isTheme[id] = 1; themeNodes.push(n); return; }
            if (t === 'aggregate') { aggs.push(n); return; }
            if (t === 'reddit_trend') { trends.push(n); return; }
            infos.push(n);
        });
        // A identifiant egal la reponse est la meme : l'agregat retenu pour un
        // bosquet ne depend pas de l'ordre des listes du serveur.
        aggs.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
        anchors.sort((a, b) => this._gCmpLabel(a, b));
        // Le bosquet se lit du plus mentionne au moins mentionne — c'est la
        // seule information qu'il porte. A egalite, l'identifiant tranche.
        trends.sort((a, b) => {
            const ca = this._n(a.meta && a.meta.count) || 0;
            const cb = this._n(b.meta && b.meta.count) || 0;
            if (ca !== cb) return cb - ca;
            return String(a.id) < String(b.id) ? -1 : 1;
        });
        pivots.sort((a, b) => this._gCmpLabel(a, b));
        infos.sort((a, b) => this._gCmpRecent(a, b));

        // Pour chaque info : les ancres qu'elle touche, et le pivot dont elle
        // est le satellite. On lit l'arete dans les DEUX sens plutot que de
        // parier sur la convention du backend (source = info, cible = ancre).
        // Le niveau des THEMES s'y glisse SANS rien changer aux deux regles
        // ci-dessus : un theme est le satellite de son hote (pivot ou ancre) et
        // se lit donc par les memes lignes ; ses feuilles, elles, ne parlent
        // plus qu'a lui — c'est la branche ajoutee en tete de la boucle.
        const hosts = {}, linkOf = {}, pivotOf = {}, pivotLink = {};
        const themeOf = {}, themeKids = {}, themeLink = {}, themesOf = {};
        edges.forEach((e) => {
            const s = String(e.source), t = String(e.target);
            // Feuille <-> theme : la feuille pend au theme, et l'arete GARDE ce
            // qu'elle disait (mecanisme + tonalite) — c'est elle qui colore le
            // lien, le backend l'a re-routee sans la vider.
            //
            // ⚠️ Un theme a DEUX sortes d'aretes : celles de ses feuilles, et
            // celle qui le rattache a son HOTE. Comme on lit les aretes dans les
            // deux sens (on ne parie pas sur la convention du backend), il faut
            // dire ce qu'une feuille n'est PAS : ni pivot, ni ancre. Sans cette
            // garde, l'arete « theme -> pivot » faisait du PIVOT une feuille de
            // son propre theme — vu a l'ecran : « Contexte mondial » dessine en
            // feuille au milieu des depeches, et une ligne de trop dans la bande.
            let kid = null;
            if (isTheme[t] && !isTheme[s] && !isPivot[s] && !isAnchor[s]) kid = [s, t];
            else if (isTheme[s] && !isTheme[t] && !isPivot[t] && !isAnchor[t]) kid = [t, s];
            if (kid && themeOf[kid[0]] === undefined) {
                themeOf[kid[0]] = kid[1]; themeLink[kid[0]] = e;
            }
            let side = null, anc = null;
            if (isAnchor[t] && !isAnchor[s]) { side = s; anc = t; }
            else if (isAnchor[s] && !isAnchor[t]) { side = t; anc = s; }
            if (side !== null) {
                if (isTheme[side]) {
                    // Un theme n'est pas une info : il ne compte pas dans les
                    // pastilles du tronc, il RANGE ce qui compte.
                    (themesOf[anc] = themesOf[anc] || []).push(byId[side]);
                    return;
                }
                const list = (hosts[side] = hosts[side] || []);
                if (list.indexOf(anc) < 0) list.push(anc);
                linkOf[side + '\u0000' + anc] = e;
                return;
            }
            if (isPivot[t] && !isPivot[s] && pivotOf[s] === undefined) {
                pivotOf[s] = t; pivotLink[s] = e;
            } else if (isPivot[s] && !isPivot[t] && pivotOf[t] === undefined) {
                pivotOf[t] = s; pivotLink[t] = e;
            }
        });
        Object.keys(hosts).forEach((k) => { hosts[k].sort(); });

        // Les feuilles d'un theme sortent des listes A PLAT : elles ne sont plus
        // atteintes par leur hote mais PAR LUI. Sans ce retrait elles seraient
        // dessinees deux fois — une fois sous le rameau, une fois sous le theme.
        themeNodes.forEach((n) => { themeKids[String(n.id)] = []; });
        nodes.forEach((n) => {
            const th = themeOf[String(n.id)];
            if (th !== undefined && themeKids[th]) themeKids[th].push(n);
        });
        Object.keys(themeKids).forEach((k) => {
            themeKids[k].sort((a, b) => this._gCmpRecent(a, b));
        });
        // Les sujets d'un hote : les gros paquets EN TETE (c'est ce qu'on vient
        // chercher), l'identifiant tranchant les ex aequo. Un theme n'a pas de
        // date : le trier par fraicheur le renverrait toujours en queue de
        // bande, derriere les feuilles restees a plat.
        const themeSort = (a, b) => {
            const ka = (themeKids[String(a.id)] || []).length;
            const kb = (themeKids[String(b.id)] || []).length;
            if (ka !== kb) return kb - ka;
            return String(a.id) < String(b.id) ? -1 : 1;
        };
        Object.keys(themesOf).forEach((k) => { themesOf[k].sort(themeSort); });
        // …et une feuille rangee sous un sujet n'est plus une feuille A PLAT.
        [infos, trends].forEach((list) => {
            for (let i = list.length - 1; i >= 0; i--) {
                if (themeOf[String(list[i].id)] !== undefined) list.splice(i, 1);
            }
        });
        // Le type EFFECTIF d'un theme est celui de ses feuilles (le serveur ne
        // groupe que DANS une famille) : sans ca, un bosquet radar dont les
        // hypotheses sont rangees en sujets se lirait « Contexte mondial ».
        const effType = (id) => {
            if (typeOf[id] !== 'theme') return typeOf[id];
            const kids = themeKids[id] || [];
            return kids.length ? this._gtype(kids[0].type) : 'other';
        };

        // --- la FORME de chaque pivot ---------------------------------------
        //
        // On compte les satellites d'un pivot par sorte. Un pivot dont tous les
        // satellites (l'agregat mis a part, qui n'est le satellite de rien) sont
        // des TENDANCES est le pivot de la foule ; tous des HYPOTHESES, celui du
        // radar. Ces deux-la portent deja leur titre traduit dans leur bosquet :
        // les redessiner en pivot n'ajouterait qu'un doublon — et un doublon
        // nomme en francais par le serveur. Tout le reste est un pivot « monde ».
        const bag = {};
        Object.keys(pivotOf).forEach((id) => {
            const pv = pivotOf[id];
            const b = (bag[pv] = bag[pv] || { trend: 0, hyp: 0, agg: 0, other: 0 });
            const t = effType(id);
            if (t === 'reddit_trend') b.trend += 1;
            else if (t === 'hypothesis') b.hyp += 1;
            else if (t === 'aggregate') b.agg += 1;
            else b.other += 1;
        });
        const roleOf = {};
        pivots.forEach((n) => {
            const id = String(n.id);
            const b = bag[id];
            let role = 'world';
            if (b && !b.other) {
                if (b.trend && !b.hyp) role = 'crowd';
                else if (b.hyp && !b.trend) role = 'radar';
            }
            roleOf[id] = role;
        });

        // L'agregat suit son pivot. Sans pivot lisible il rejoint les infos :
        // il finira satellite du bosquet « monde » plutot que de disparaitre —
        // un compteur qu'on n'affiche pas ment par omission.
        const aggOf = {};
        aggs.forEach((n) => {
            const pv = pivotOf[String(n.id)];
            if (pv !== undefined && aggOf[pv] === undefined) { aggOf[pv] = n; return; }
            if (pv === undefined) infos.push(n);
        });

        // Les hypotheses du bosquet radar sortent des infos : ce ne sont pas des
        // feuilles de tronc, elles ont leur propre bosquet. Celles qui touchent
        // un titre, elles, restent des feuilles — c'est la ou elles parlent.
        const inRadar = {};
        Object.keys(pivotOf).forEach((id) => {
            if (typeOf[id] === 'hypothesis'
                && roleOf[pivotOf[id]] === 'radar') inRadar[id] = 1;
        });
        const radarItems = infos.filter((n) => inRadar[String(n.id)]);
        const rest = infos.filter((n) => !inRadar[String(n.id)]);
        // …et les hypotheses RANGEES EN SUJETS dans ce meme bosquet : elles
        // n'ont plus de pivot direct, c'est leur theme qui l'a.
        const themedRadar = themeNodes.filter((n) =>
            roleOf[pivotOf[String(n.id)]] === 'radar');

        // Satellites d'un pivot, DEJA tries : on les prend dans les listes deja
        // ordonnees (tendances par nombre de mentions, le reste par fraicheur)
        // plutot que de retrier — c'est ce qui garantit que deplier un bosquet
        // deux fois donne exactement le meme arbre. L'agregat n'y est PAS : il
        // se pose a part, au pied de l'arbre.
        const satOf = {};
        const bucket = (n) => {
            const pv = pivotOf[String(n.id)];
            if (pv === undefined) return;
            (satOf[pv] = satOf[pv] || []).push(n);
        };
        // Les SUJETS ouvrent la bande : un theme est un satellite du pivot
        // comme les autres, mais il en range plusieurs — le mettre en tete,
        // c'est mettre le gros paquet la ou l'oeil arrive.
        themeNodes.slice().sort(themeSort).forEach(bucket);
        trends.forEach(bucket);
        radarItems.forEach(bucket);
        rest.forEach(bucket);

        // « loose » = ce qui ne pend a aucun tronc mais doit quand meme exister
        // en vue rapprochee, ou il n'y a plus de coin ou aller.
        const loose = radarItems.concat(themedRadar, aggs.filter((n) =>
            pivotOf[String(n.id)] !== undefined));

        return { anchors: anchors, infos: rest, trends: trends,
            pivots: pivots.filter((n) => roleOf[String(n.id)] === 'world'),
            allPivots: pivots, roleOf: roleOf, satOf: satOf,
            hosts: hosts, linkOf: linkOf, pivotOf: pivotOf, pivotLink: pivotLink,
            aggOf: aggOf, loose: loose, radarItems: radarItems,
            themes: themeNodes, themeOf: themeOf, themeKids: themeKids,
            themeLink: themeLink, themesOf: themesOf };
    },

    _gCmpLabel(a, b) {
        const la = String(a.label === undefined || a.label === null ? a.id : a.label);
        const lb = String(b.label === undefined || b.label === null ? b.id : b.label);
        if (la !== lb) return la < lb ? -1 : 1;
        return String(a.id) < String(b.id) ? -1 : 1;
    },

    _gCmpRecent(a, b) {
        const ta = this._graphTs(a), tb = this._graphTs(b);
        if (tb !== ta) return tb - ta;
        return String(a.id) < String(b.id) ? -1 : 1;
    },

    // ----------------------------------------------------------- fiches noeud

    // Le libelle AFFICHE. Le pivot « monde » arrive nomme en francais par le
    // backend : on lui rend son nom traduit — c'est un noeud du systeme, pas
    // une donnee. Une tendance qui MONTE porte sa fleche.
    _gLabelOf(n, t) {
        if (t === 'context') return this._gPivotLabel('world');
        const base = String(n.label === undefined || n.label === null ? n.id : n.label);
        // L'agregat arrive lui aussi nomme en francais par le serveur
        // (« +67 autres ») : on le RECONSTRUIT depuis son compteur, sinon un
        // ecran en anglais afficherait un mot francais. Compteur illisible : on
        // garde le libelle du serveur plutot que d'afficher un « + » tout seul.
        if (t === 'aggregate') {
            const k = this._n(n.meta && n.meta.count);
            return (k === null || k < 0) ? base
                : ('+' + this._num(k, 0) + ' ' + Lang.t('paper.graph_agg_more'));
        }
        // Le fourre-tout d'un regroupement arrive lui aussi nomme en francais
        // (« Divers ») : on le RECONNAIT par sa cle — whitelist fermee — et on
        // rend le nom de la langue de l'ecran. Un sujet nomme, lui, est fait
        // des mots du titre : il n'a pas de traduction, et n'en veut pas.
        if (t === 'theme') {
            const k = String((n.meta && n.meta.key) == null ? '' : n.meta.key);
            return (k === this._GTHEME_MISC) ? Lang.t('paper.theme_misc') : base;
        }
        if (t !== 'reddit_trend') return base;
        const c = this._n(n.meta && n.meta.count), p = this._n(n.meta && n.meta.prev);
        return (c !== null && p !== null && c > p) ? (base + ' ' + this._GTREND_UP) : base;
    },

    // Rayon d'une tendance : DOUCEMENT proportionnel au nombre de mentions
    // (racine carree, bornee des deux cotes). Une tendance dix fois plus grosse
    // ne doit pas faire une pastille dix fois plus large : elle ecraserait tout
    // le bosquet et on ne verrait plus les autres.
    _gTrendR(n) {
        const c = this._n(n && n.meta && n.meta.count);
        const v = (c === null || c < 0) ? 0 : c;
        return 5 + Math.min(8, Math.sqrt(v) * 1.9);
    },

    // « 12 mentions 24 h (avant : 5) ». Sans compteur lisible : rien du tout —
    // on n'affiche pas une phrase a trous.
    _gTrendLines(n) {
        const c = this._n(n && n.meta && n.meta.count);
        if (c === null) return [];
        const head = this._num(c, 0) + ' ' + Lang.t('paper.graph_trend_mentions');
        const p = this._n(n.meta.prev);
        return [p === null ? head
            : (head + ' (' + Lang.t('paper.graph_trend_prev') + ' ' + this._num(p, 0) + ')')];
    },

    // « 67 elements de plus, non dessines ». L'agregat DIT ce qu'il cache : sans
    // cette phrase, un anneau muet laisserait croire que le bosquet est complet.
    _gAggLines(n) {
        const c = this._n(n && n.meta && n.meta.count);
        if (c === null || c < 0) return [];
        return [this._num(c, 0) + ' ' + Lang.t('paper.graph_agg_tip')];
    },

    // Verdict d'une hypothese, en toutes lettres dans l'infobulle : la pastille
    // de couleur posee a cote du noeud ne se lit pas seule.
    _gHypLines(n) {
        const c = this._gOutcome(n && n.outcome);
        return c ? [Lang.t(this._GHYP_OUT[c][1])] : [];
    },

    // Verdict lu par WHITELIST : un code inconnu ne fabrique ni couleur ni cle
    // i18n — il ne produit simplement aucune pastille.
    _gOutcome(o) {
        const c = this._gtype(o);
        return Object.prototype.hasOwnProperty.call(this._GHYP_OUT, c) ? c : '';
    },

    // « 8 elements sous ce sujet ». Le compteur du serveur, en toutes lettres :
    // la pastille dit de QUOI on parle, l'infobulle dit COMBIEN.
    _gThemeLines(n) {
        const c = this._n(n && n.meta && n.meta.count);
        if (c === null || c < 0) return [];
        return [this._num(c, 0) + ' ' + Lang.t('paper.theme_count')];
    },

    _gLines(n, t) {
        if (t === 'reddit_trend') return this._gTrendLines(n);
        if (t === 'aggregate') return this._gAggLines(n);
        if (t === 'hypothesis') return this._gHypLines(n);
        if (t === 'theme') return this._gThemeLines(n);
        return [];
    },

    // Nom d'un bosquet, par son ROLE (reconnu a la forme) et jamais par son
    // identifiant serveur : les trois arrivent nommes en francais, on leur rend
    // le nom de la langue de l'ecran. Role inconnu -> le nom du monde, qui est
    // le cas general d'un pivot contexte.
    _GPIVOT_LABEL: {
        world: 'paper.gnode_context',
        crowd: 'paper.gnode_reddit',
        radar: 'paper.gnode_radar',
    },

    _gPivotLabel(role) {
        const k = String(role == null ? '' : role);
        return Lang.t(Object.prototype.hasOwnProperty.call(this._GPIVOT_LABEL, k)
            ? this._GPIVOT_LABEL[k] : 'paper.gnode_context');
    },

    // Couleur d'un bosquet : celle de ce qu'il contient. Le monde n'a pas de
    // famille (il melange politique, crypto et macro) -> le gris du decor.
    _GPIVOT_TOKEN: { world: '--text-dim', crowd: '--dot-magenta', radar: '--info' },

    _gPivotColor(role) {
        const k = String(role == null ? '' : role);
        return this._tok(Object.prototype.hasOwnProperty.call(this._GPIVOT_TOKEN, k)
            ? this._GPIVOT_TOKEN[k] : '--text-dim') || '#8FA3C4';
    },

    // Fiche de noeud pour la disposition : on ne recopie QUE des champs connus,
    // rien du serveur ne se glisse dans le dessin par surprise.
    _gRec(n, extra) {
        const t = this._gtype(n.type);
        return {
            id: String(n.id),
            kind: extra.kind,
            type: t,
            fam: this._gfam(t),
            label: this._gLabelOf(n, t),
            meta: (n.meta && typeof n.meta === 'object') ? n.meta : null,
            lines: this._gLines(n, t),
            ts: n.ts,
            link: this._safeUrl(n.link),
            sentiment: n.sentiment,
            outcome: this._gOutcome(n.outcome),
            anchor: this._isAnchorType(t),
            counts: extra.counts || null,
            x: extra.x, y: extra.y, r: extra.r,
            gx: extra.gx, gy: extra.gy,
            labelPos: extra.labelPos,
            // Plafond d'etiquette IMPOSE par la disposition, quand elle sait
            // que la place manque (les deux ailes du dernier niveau d'un
            // bosquet se font face). 0 = la disposition ne dit rien, c'est le
            // plafond par type qui s'applique.
            labelMax: extra.labelMax || 0,
        };
    },

    // Rameau : un noeud SYNTHETIQUE, il ne vient d'aucune donnee. Son type
    // « branch » n'est pas dans _GNODE : il n'a donc ni libelle de type ni
    // pastille de legende propre — c'est voulu, il EST la famille de source.
    _gBranchRec(anchorId, fam, count, x, y, gx, gy, labelPos) {
        return {
            id: 'br:' + anchorId + '\u0000' + fam,
            kind: 'branch', type: 'branch', fam: fam,
            label: this._gfamLabel(fam),
            meta: null,
            lines: [this._num(count, 0) + ' ' + Lang.t('paper.graph_items')],
            ts: '', link: '', sentiment: '', anchor: false,
            x: x, y: y, r: 5.5, gx: gx, gy: gy, labelPos: labelPos,
        };
    },

    // « conv » marque un fil de CONVERGENCE : une depeche d'une autre famille
    // qui parle du meme sujet et arrive du bord droit du cadre. Il traverse tout
    // le dessin, donc il se tient plus en retrait au repos que les fils courts
    // de l'eventail — sans quoi une dizaine de longues courbes mangeraient
    // l'image. Sous le curseur, il s'allume comme les autres.
    _gDataEdge(a, b, e, conv) {
        return {
            a: a, b: b,
            sentiment: e ? e.sentiment : '',
            type: e ? e.type : '',
            struct: false, cross: false, conv: !!conv,
        };
    },

    _gBBox(list) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        list.forEach((n) => {
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
        });
        if (!isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
        return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
    },

    // ------------------------------------------------------ vue globale : index
    //
    // La vue globale ne dessine AUCUNE feuille. Elle repond a une seule
    // question : « ou est-ce que ca chauffe ? ». Un TRONC par titre suivi,
    // portant ses compteurs par famille de source ; trois CARTES du meme rang
    // pour les bosquets qui ne nomment aucun titre (monde, foule, radar). Le
    // detail se deplie d'un clic.
    //
    // Pourquoi ce renoncement : dessiner ici tout ce que la memoire contient
    // donnait des arcs de points muets des que le decor mondial se remplissait
    // (79 evenements politiques ont suffi a manger le plafond de dessin —
    // capture utilisateur a l'appui). Un index dit la meme chose en une image
    // qui tient, et le detail reste a un clic.

    _layoutIndex(nodes, cssW) {
        const P = this._graphParts(nodes);
        const out = [];
        const push = (rec) => { out.push(rec); return out.length - 1; };

        // --- 1. compter, par titre, ce que chaque famille a apporte ---------
        // On lit les HOTES (l'arete titre <-> info, deja relue dans les deux
        // sens par _graphParts), donc une tendance de la foule rattachee a un
        // titre compte comme sociale POUR CE TITRE — c'est bien ce qu'elle est.
        // Cle composee jointe par un OCTET NUL, comme partout ailleurs ici : un
        // symbole peut contenir un point ou une espace, jamais un octet nul.
        const famCount = {};
        nodes.forEach((n) => {
            if (this._isAnchorType(n.type)) return;
            const fam = this._gfam(n.type) || 'other';
            (P.hosts[String(n.id)] || []).forEach((a) => {
                const k = a + '\u0000' + fam;
                famCount[k] = (famCount[k] || 0) + 1;
            });
        });

        // --- 2. les cellules : titres (ordre alphabetique) puis bosquets ----
        // L'ordre des bosquets est FIXE : un objet JSON n'a pas d'ordre, et
        // deux rendus des memes donnees doivent donner exactement la meme image.
        const cells = P.anchors.map((n) => ({ node: n, role: '' }));
        this._GPIVOT_ORDER.forEach((role) => {
            P.allPivots.forEach((n) => {
                if (P.roleOf[String(n.id)] === role) cells.push({ node: n, role: role });
            });
        });
        if (!cells.length) return null;

        // --- 3. la grille ---------------------------------------------------
        // Carree autant que possible : c'est la forme qui laisse la plus grande
        // echelle apres l'homothetie, donc les etiquettes les plus lisibles. La
        // largeur DISPONIBLE borne le nombre de colonnes — sur un telephone
        // l'index devient une simple colonne, ce qui est sa forme naturelle.
        const COL = 300, ROW = 152;
        const w = (cssW > 0) ? cssW : 900;
        const maxCols = Math.max(1, Math.min(5, Math.floor((w - 160) / 200)));
        const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(cells.length))));
        const rows = Math.ceil(cells.length / cols);

        cells.forEach((c, i) => {
            const col = i % cols, row = Math.floor(i / cols);
            const x = (col - (cols - 1) / 2) * COL;
            const y = (row - (rows - 1) / 2) * ROW;
            if (!c.role) {
                const a = String(c.node.id);
                const badges = this._GFAM_ORDER
                    .filter((f) => famCount[a + '\u0000' + f])
                    .map((f) => ({ fam: f, role: '', n: famCount[a + '\u0000' + f] }));
                push(this._gRec(c.node, {
                    kind: 'anchor', x: x, y: y, r: 11, gx: 0, gy: -1,
                    labelPos: 'below', counts: badges,
                }));
                return;
            }
            // La carte d'un bosquet annonce son TOTAL : ce qui se dessine quand
            // on le deplie, PLUS ce que le serveur a range dans l'agregat.
            // Annoncer les douze visibles ferait passer « 79 » pour « 12 ».
            const pid = String(c.node.id);
            const kept = (P.satOf[pid] || []).length;
            const agg = P.aggOf[pid];
            const more = agg ? this._n(agg.meta && agg.meta.count) : null;
            const total = kept + ((more === null || more < 0) ? 0 : more);
            const rec = this._gRec(c.node, {
                kind: 'card', x: x, y: y, r: 11, gx: 0, gy: -1,
                labelPos: 'below', counts: [{ fam: '', role: c.role, n: total }],
            });
            rec.label = this._gPivotLabel(c.role);
            rec.role = c.role;
            push(rec);
        });

        return { nodes: out, edges: [], titles: [], baseline: null, maxScale: 2.2 };
    },

    // Ordre FIXE des cartes de bosquet, et famille de chacune. Le monde n'a pas
    // de famille : il melange politique, crypto et macro.
    _GPIVOT_ORDER: ['world', 'crowd', 'radar'],
    _GPIVOT_FAM: { crowd: 'social', radar: 'radar' },

    _gPivotFam(role) {
        const k = String(role == null ? '' : role);
        return Object.prototype.hasOwnProperty.call(this._GPIVOT_FAM, k)
            ? this._GPIVOT_FAM[k] : '';
    },

    // Couleur d'un compteur : celle de sa famille de source, ou celle du
    // bosquet quand le compteur est le total d'une carte.
    _gBadgeColor(b) {
        if (b && b.fam) return this._gfamColor(b.fam);
        return this._gPivotColor(b && b.role);
    },

    _gBadgeLabel(b) {
        if (b && b.fam) return this._gfamLabel(b.fam);
        return this._gPivotLabel(b && b.role);
    },

    // ------------------------------------------- vue rapprochee : arbre couche

    _layoutTree(nodes) {
        const P = this._graphParts(nodes);
        const want = this._graphRootId();

        // Le sujet deplie est soit un TITRE (l'arbre vient du serveur, qui a
        // renvoye son voisinage), soit un BOSQUET (deplie sur place, dans la
        // toile deja chargee — aucune requete : le serveur ne connait pas
        // « monde » comme un symbole). La FORME est la meme dans les deux cas.
        let root = null, role = '', items = null, agg = null;
        P.allPivots.forEach((n) => {
            if (root !== null || String(n.id) !== want) return;
            root = n;
            role = P.roleOf[want] || 'world';
            items = (P.satOf[want] || []).slice();
            agg = P.aggOf[want] || null;
        });
        if (root === null) {
            P.anchors.forEach((n) => { if (root === null && String(n.id) === want) root = n; });
            if (root === null) root = P.anchors.length ? P.anchors[0] : null;
            // Pas d'ancre du tout : il n'y a pas de sujet a arborer. On retombe
            // sur l'index plutot que d'inventer un tronc que la memoire ne
            // porte pas.
            if (root === null) return this._layoutIndex(nodes, 0);
            // Tendances, pivots et bosquets compris : en vue rapprochee, TOUT
            // ce que la memoire rattache a ce titre devient une feuille — il
            // n'y a plus de coin oppose ou aller, et rien ne doit disparaitre.
            // Les SUJETS de ce titre ouvrent la liste : ce sont eux qui portent
            // les feuilles que le serveur a rangees.
            items = (P.themesOf[want] || []).concat(P.infos, P.trends, P.pivots,
                P.loose);
        }

        const out = [], edges = [], titles = [];
        const push = (rec) => { out.push(rec); return out.length - 1; };
        const X_BR = 200, X_LEAF = 230, GAP_LEAF = 30, GAP_FAM = 36;
        // Un cran de plus quand un SUJET s'intercale : le sujet prend la place
        // de la feuille (X_LEAF), ses feuilles reculent d'autant.
        const X_KID = 250;
        const isTheme = (n) => this._gtype(n.type) === 'theme';
        // La famille d'un sujet est celle de ses feuilles — le serveur ne
        // groupe que DANS une famille, elles n'en ont donc qu'une.
        const famOf = (n) => {
            if (!isTheme(n)) return this._gfam(n.type) || 'other';
            const kids = P.themeKids[String(n.id)] || [];
            return kids.length ? (this._gfam(kids[0].type) || 'other') : 'other';
        };
        // Combien de LIGNES un item occupe dans sa bande : une feuille en prend
        // une, un sujet en prend autant que de feuilles — sinon deux sujets
        // voisins se marcheraient dessus.
        const rowsOf = (n) => (isTheme(n)
            ? Math.max(1, (P.themeKids[String(n.id)] || []).length) : 1);
        // L'arete de DONNEE entre une feuille restee a plat et le sujet
        // deplie (cle composee jointe par un OCTET NUL, comme partout ici).
        const hostLink = (n) => P.linkOf[String(n.id) + '\u0000' + String(root.id)];

        const rootRec = this._gRec(root, {
            kind: role ? 'card' : 'anchor', x: 0, y: 0, r: 10,
            gx: 1, gy: 0, labelPos: 'below',
        });
        if (role) { rootRec.label = this._gPivotLabel(role); rootRec.role = role; }
        const ri = push(rootRec);

        const groups = {};
        items.forEach((n) => {
            const f = famOf(n);
            (groups[f] = groups[f] || []).push(n);
        });
        const fams = this._GFAM_ORDER.filter((f) => groups[f] && groups[f].length);

        // Bandes verticales : la hauteur d'une famille suit son nombre de
        // LIGNES (feuilles rangees en sujets comprises), donc deux feuilles ne
        // peuvent pas se marcher dessus.
        let cursor = 0;
        const bands = fams.map((f) => {
            let lines = 0;
            groups[f].forEach((n) => { lines += rowsOf(n); });
            const h = Math.max(1, lines) * GAP_LEAF;
            const band = { fam: f, top: cursor, h: h };
            cursor += h + GAP_FAM;
            return band;
        });
        const y0 = -Math.max(1, cursor - GAP_FAM) / 2;

        // Une feuille : la SORTE suit le TYPE, jamais le chemin par lequel le
        // noeud est arrive — un agregat garde son anneau meme quand il tombe
        // dans une bande de famille (vue rapprochee d'un titre).
        const leafRec = (n, x, y) => {
            const t = this._gtype(n.type);
            const li = push(this._gRec(n, {
                kind: (t === 'reddit_trend') ? 'trend'
                    : ((t === 'aggregate') ? 'agg' : 'leaf'),
                x: x, y: y,
                r: (t === 'reddit_trend') ? this._gTrendR(n)
                    : ((t === 'aggregate') ? 6.5 : 4.5),
                gx: 1, gy: 0, labelPos: 'right',
            }));
            // Un agregat tombe dans une bande de famille reste un COMPTEUR : il
            // doit savoir DE QUEL bosquet il compte le reste, sinon le clic
            // « tout voir » n'aurait rien a demander.
            if (t === 'aggregate') {
                out[li].grove = this._groveKindOf(P.pivotOf[String(n.id)]);
            }
            return li;
        };

        bands.forEach((band) => {
            // Les SUJETS sont deja ranges (les gros paquets en tete, cf.
            // _graphParts) ; les feuilles restees a plat suivent, de la plus
            // fraiche a la plus vieille. On ne retrie donc QUE ces dernieres.
            const themesHere = groups[band.fam].filter(isTheme);
            const flat = groups[band.fam].filter((n) => !isTheme(n))
                .sort((a, b) => this._gCmpRecent(a, b));
            let lines = 0;
            groups[band.fam].forEach((n) => { lines += rowsOf(n); });
            const bi = push(this._gBranchRec(String(root.id), band.fam, lines,
                X_BR, y0 + band.top + band.h / 2, 1, 0, 'above'));
            edges.push({ a: ri, b: bi, sentiment: '', type: '', struct: true, cross: false });

            let row = 0;
            themesHere.concat(flat).forEach((n) => {
                if (!isTheme(n)) {
                    const li = leafRec(n, X_BR + X_LEAF + ((row % 2) ? 26 : 0),
                        y0 + band.top + GAP_LEAF * (row + 0.5));
                    edges.push(this._gDataEdge(bi, li, hostLink(n)));
                    row += 1;
                    return;
                }
                // Le SUJET : une etiquette a la place d'une feuille, et ses
                // feuilles en eventail derriere lui. Son rayon est la DEMI-
                // HAUTEUR de sa pastille ; sa largeur se mesure au trace, ou le
                // texte affiche est connu (cf. _paintGraph).
                const kids = P.themeKids[String(n.id)] || [];
                const span = rowsOf(n);
                const ti = push(this._gRec(n, {
                    kind: 'theme', x: X_BR + X_LEAF,
                    y: y0 + band.top + GAP_LEAF * (row + span / 2),
                    r: 9, gx: 1, gy: 0, labelPos: 'center',
                }));
                // La couleur d'un sujet est celle de sa bande : il ne vient
                // d'aucune source, il range celles de ses feuilles.
                out[ti].fam = band.fam;
                // Un sujet de BOSQUET sait lequel : son clic ouvre la liste
                // complete, ou les memes sujets font les intertitres.
                out[ti].grove = this._groveKindOf(P.pivotOf[String(n.id)]);
                edges.push({ a: bi, b: ti, sentiment: '', type: '', struct: true, cross: false });
                kids.forEach((k, j) => {
                    const ki = leafRec(k, X_BR + X_LEAF + X_KID + ((j % 2) ? 26 : 0),
                        y0 + band.top + GAP_LEAF * (row + j + 0.5));
                    edges.push(this._gDataEdge(ti, ki, P.themeLink[String(k.id)]));
                });
                row += span;
            });
        });

        // L'agregat au PIED de l'arbre, accroche au tronc et a rien d'autre :
        // il ne vient d'aucune famille, et le ranger dans « Autre » lui
        // inventerait une source. C'est un compteur — il dit ce que le serveur
        // n'a pas envoye, et il le dit toujours (jamais masque par l'echelle).
        if (agg) {
            const bottom = y0 + Math.max(1, cursor - GAP_FAM);
            const aggRec = this._gRec(agg, {
                kind: 'agg', x: X_BR, y: bottom + 40, r: 6.5,
                gx: 1, gy: 0, labelPos: 'right',
            });
            aggRec.fam = this._gPivotFam(role);
            // Le bosquet qu'il resume : c'est CE nom que le clic « tout voir »
            // envoie au serveur, et rien d'autre ne le porte.
            aggRec.grove = this._groveKindOf(String(root.id));
            const ai = push(aggRec);
            edges.push({ a: ri, b: ai, sentiment: '', type: '', struct: true, cross: false });
        }

        // Les feuilles portent leur nom A DROITE : sans cette reserve, le
        // dernier mot de chaque ligne sort du cadre (mesure : coupe nette au
        // bord du canvas des que l'echelle plafonne). La reserve suit la plus
        // LONGUE etiquette possible — une these du radar, quarante signes —
        // sinon c'est elle, et elle seule, qui se fait couper.
        return { nodes: out, edges: edges, titles: titles, baseline: null,
            padRight: 280 };
    },

    // ----------------------------------- vue rapprochee : bosquet PAR NIVEAUX
    //
    // Un bosquet ne se lit plus d'un bloc. On DESCEND : les FAMILLES de source
    // qu'il contient, puis les SUJETS de la famille choisie, puis — quand le
    // serveur a su subdiviser un gros sujet — ses SOUS-SUJETS, puis ses
    // DEPECHES. A chaque cran, peu de noeuds, tous nommes, tous comptes —
    // l'inverse de l'arc de douze points muets double d'un « +64 autres » qu'on
    // ne pouvait pas ouvrir (retour utilisateur du 26/08, capture a l'appui).
    //
    // La source est la LISTE ENTIERE du bosquet (/graph/grove, lue une fois et
    // gardee), jamais les douze satellites du dessin : c'est ce qui permet de
    // compter juste et de ne plus rien cacher.
    //
    // FORME identique a tous les niveaux : un TRONC (ce qu'on vient d'ouvrir,
    // nomme et compte) et ses enfants en eventail a droite. Le tronc remonte
    // d'un cran ; le fil d'Ariane au-dessus du canvas dit ou l'on est.
    //
    // Le DERNIER niveau ajoute une seconde aile : les depeches des AUTRES
    // familles qui parlent du meme sujet, ancrees au bord droit du cadre,
    // etiquettes a gauche, convergeant sur le sujet. Le sujet devient alors ce
    // qu'il est vraiment — un point ou plusieurs mondes se rejoignent.
    _layoutDrill() {
        const D = this._drillPlan(this._graphPivot);
        if (!D.kind) return null;
        const out = [], edges = [];
        const push = (rec) => { out.push(rec); return out.length - 1; };
        const X = 210, GAP = 46, GAP_LEAF = 30;
        // Un tronc qui n'a rien au-dessus de lui ne promet pas de remontee : un
        // niveau saute quand il n'aurait qu'un noeud, donc un bosquet a une
        // seule famille n'a PAS de niveau familles ou revenir.
        const upCta = D.up ? 'paper.gdrill_up' : '';
        const upFam = D.up ? D.up.fam : '';
        const upTheme = D.up ? D.up.theme : '';
        const upSub = D.up ? D.up.sub : '';

        let trunk;
        if (D.level === 1) {
            trunk = this._gDrillRec('card', {
                id: 'gd ' + D.kind, type: 'context',
                label: this._gPivotLabel(D.role), fam: '',
                x: 0, y: 0, r: 11, labelPos: 'below',
                counts: [{ fam: '', role: D.role, n: D.items.length }],
                drillFam: '', drillTheme: '', drillSub: '', cta: '',
            });
            trunk.role = D.role;
        } else if (D.level === 2) {
            trunk = this._gDrillRec('fam', {
                id: 'gd ' + D.kind + ' ' + D.fam, type: 'branch',
                label: this._gfamLabel(D.fam), fam: D.fam,
                x: 0, y: 0, r: 10, labelPos: 'below',
                counts: [{ fam: D.fam, role: '', n: D.famItems.length }],
                drillFam: upFam, drillTheme: upTheme, drillSub: upSub, cta: upCta,
            });
        } else if (D.level === 3) {
            trunk = this._gDrillRec('sub', {
                id: 'gd ' + D.kind + ' ' + D.fam + ' ' + D.theme,
                type: 'theme', label: D.themeLabel, fam: D.fam,
                x: 0, y: 0, r: 10, labelPos: 'below',
                counts: [{ fam: D.fam, role: '', n: D.themeRows.length }],
                drillFam: upFam, drillTheme: upTheme, drillSub: upSub, cta: upCta,
            });
        } else {
            // Le tronc du dernier niveau porte le nom de CE QU'ON A OUVERT : le
            // sous-sujet quand cet etage existe, le sujet quand il a ete saute.
            trunk = this._gDrillRec('sub', {
                id: 'gd ' + D.kind + ' ' + D.fam + ' ' + D.theme + ' ' + D.sub,
                type: 'theme', label: D.leafLabel, fam: D.fam,
                x: 0, y: 0, r: 10, labelPos: 'below',
                counts: [{ fam: D.fam, role: '', n: D.leaves.length }],
                drillFam: upFam, drillTheme: upTheme, drillSub: upSub, cta: upCta,
            });
        }
        const ri = push(trunk);
        const hang = (ci) => {
            edges.push({ a: ri, b: ci, sentiment: '', type: '', struct: true, cross: false });
        };

        if (D.level === 1) {
            const m = D.fams.length;
            D.fams.forEach((f, i) => {
                hang(push(this._gDrillRec('fam', {
                    id: 'gd ' + D.kind + ' ' + f, type: 'branch',
                    label: this._gfamLabel(f), fam: f,
                    x: X, y: (i - (m - 1) / 2) * GAP, r: 8, labelPos: 'right',
                    tail: this._num(D.byFam[f].length, 0),
                    drillFam: f, drillTheme: '', drillSub: '',
                    cta: 'paper.gdrill_open_fam',
                })));
            });
        } else if (D.level === 2) {
            const m = D.themes.length;
            D.themes.forEach((t, i) => {
                hang(push(this._gDrillRec('sub', {
                    id: 'gd ' + D.kind + ' ' + D.fam + ' ' + t.key,
                    type: 'theme', label: t.label, fam: D.fam,
                    x: X, y: (i - (m - 1) / 2) * GAP, r: 8, labelPos: 'right',
                    tail: this._num(t.rows.length, 0),
                    drillFam: D.fam, drillTheme: t.key, drillSub: '',
                    cta: 'paper.gdrill_open_theme',
                })));
            });
        } else if (D.level === 3) {
            // Un gros sujet se subdivise : ses SOUS-SUJETS, meme forme et memes
            // regles que les sujets un cran plus haut (tous affiches, comptes,
            // les gros d'abord, le fourre-tout en queue).
            const m = D.subs.length;
            D.subs.forEach((s, i) => {
                hang(push(this._gDrillRec('sub', {
                    id: 'gd ' + D.kind + ' ' + D.fam + ' ' + D.theme + ' ' + s.key,
                    type: 'theme', label: s.label, fam: D.fam,
                    x: X, y: (i - (m - 1) / 2) * GAP, r: 8, labelPos: 'right',
                    tail: this._num(s.rows.length, 0),
                    drillFam: D.fam, drillTheme: D.theme, drillSub: s.key,
                    cta: 'paper.gdrill_open_sub',
                })));
            });
        } else {
            // Le dernier niveau, en DEUX ailes.
            //
            // L'EVENTAIL, a droite du tronc, porte le gros du sujet — par
            // defaut la famille ouverte, celle qu'on est venu lire. L'aile de
            // CONVERGENCE, ancree au bord droit du cadre et etiquetee a gauche,
            // porte ce que les AUTRES familles disent du meme sujet : c'est la
            // corroboration, et elle se VOIT.
            //
            // Quand les autres sources sont PLUS NOMBREUSES, les roles
            // s'inversent : l'eventail dit toujours « voila le gros », et ce
            // serait mentir que de le reserver a la famille minoritaire.
            const fanAll = D.convSwap ? D.cross : D.leaves;
            const edgeAll = D.convSwap ? D.leaves : D.cross;
            // Les plus recentes DESSINEES — dans l'ordre ou le serveur les a
            // rangees, qui est deja celui du dessin (la fraicheur partout, les
            // hypotheses ouvertes d'abord au radar). Re-trier ici ferait
            // diverger le canvas de la liste, qui raconte la meme histoire.
            const fan = fanAll.slice(0, this._GDRILL_LEAVES);
            const wing = edgeAll.slice(0, this._GDRILL_CROSS);
            // Les deux ailes se font face : leurs etiquettes courent l'une vers
            // l'autre, et sans plafond elles se rejoindraient au milieu.
            const tight = wing.length > 0;
            const m = fan.length;
            fan.forEach((n, i) => {
                const t = this._gtype(n.type);
                const li = push(this._gRec(n, {
                    kind: (t === 'reddit_trend') ? 'trend' : 'leaf',
                    x: X + ((i % 2) ? 26 : 0),
                    y: (i - (m - 1) / 2) * GAP_LEAF,
                    r: (t === 'reddit_trend') ? this._gTrendR(n) : 4.5,
                    gx: 1, gy: 0, labelPos: 'right',
                    labelMax: tight ? this._GDRILL_FAN_LABEL : 0,
                }));
                // L'arete porte la TONALITE de la depeche : le noeud dit d'ou
                // elle vient, le lien dit ce qu'elle raconte — les deux
                // alphabets de la toile, jusqu'au dernier niveau.
                edges.push(this._gDataEdge(ri, li, { sentiment: n.sentiment, type: '' }));
            });
            const k = wing.length;
            const XR = this._GDRILL_CROSS_X, GAP_CROSS = this._GDRILL_CROSS_GAP;
            wing.forEach((n, j) => {
                const t = this._gtype(n.type);
                const li = push(this._gRec(n, {
                    kind: (t === 'reddit_trend') ? 'trend' : 'leaf',
                    x: XR,
                    y: (j - (k - 1) / 2) * GAP_CROSS,
                    r: (t === 'reddit_trend') ? this._gTrendR(n) : 4.5,
                    // Meme pousse que l'eventail : la courbe quitte le tronc
                    // vers la droite et arrive sur la pastille par sa gauche —
                    // un entonnoir, pas un crochet. Seule l'ETIQUETTE bascule
                    // de l'autre cote, et c'est elle qui fait le miroir.
                    gx: 1, gy: 0, labelPos: 'left',
                    labelMax: this._GDRILL_CROSS_LABEL,
                }));
                edges.push(this._gDataEdge(ri, li,
                    { sentiment: n.sentiment, type: '' }, true));
            });
        }

        // Les feuilles portent leur nom A DROITE : sans cette reserve, le
        // dernier mot de chaque ligne sort du cadre. Les etages de navigation
        // en demandent moins (un nom de famille ou de sujet, plus son compteur).
        // Quand l'aile de convergence est la, la reserve de droite retombe :
        // les pastilles du bord ecrivent leur nom vers la GAUCHE, et garder 280
        // px de vide a droite ne ferait que serrer tout le dessin.
        const conv = (D.level === 4 && D.cross.length > 0);
        return { nodes: out, edges: edges, titles: [], baseline: null,
            // Le tronc de ce niveau-la se retrouve au ras de la marge gauche
            // (le dessin est alors contraint en largeur) : son nom, ecrit
            // CENTRE dessous, a besoin de sa moitie.
            padLeft: conv ? 110 : 0,
            padRight: (D.level === 4) ? (conv ? 70 : 280) : 240,
            // Peu de noeuds a l'etage de navigation : on les laisse s'ecarter,
            // sinon trois pastilles se serrent au milieu d'un cadre vide.
            maxScale: (D.level === 4) ? 1.35 : 1.7 };
    },

    // Fiche d'un noeud de NAVIGATION (tronc, famille, sujet) : synthetique, il
    // ne vient d'aucune donnee. Meme forme que _gRec pour que le trace n'ait
    // jamais a savoir d'ou vient le noeud qu'il dessine.
    _gDrillRec(kind, o) {
        return {
            id: String(o.id), kind: kind, type: String(o.type || ''),
            fam: o.fam || '', label: String(o.label == null ? '' : o.label),
            meta: null, lines: [], ts: '', link: '', sentiment: '', outcome: '',
            anchor: false, counts: o.counts || null, tail: o.tail || '',
            cta: o.cta || '',
            // Ces trois-la disent OU mene le clic. Definis (meme vides) sur tout
            // noeud de bosquet : c'est a ca que _graphActivate le reconnait.
            drillFam: String(o.drillFam == null ? '' : o.drillFam),
            drillTheme: String(o.drillTheme == null ? '' : o.drillTheme),
            drillSub: String(o.drillSub == null ? '' : o.drillSub),
            x: o.x, y: o.y, r: o.r, gx: 1, gy: 0, labelPos: o.labelPos,
        };
    },

    // Une seule homothetie ramene tout le monde dans le cadre : la toile occupe
    // toujours la place disponible, sans qu'aucune constante ait a deviner la
    // taille de l'ecran. Les RAYONS, eux, ne suivent pas l'echelle : une
    // pastille de deux pixels ne se vise plus a la souris.
    _graphFit(raw, cssW, cssH) {
        // Les TITRES entrent dans la boite : poses au-dessus du premier noeud,
        // ils sortiraient du cadre si l'homothetie ne comptait que les
        // pastilles (constate : titre coupe en haut du cadre).
        const bb = this._gBBox(raw.nodes.concat(raw.titles));
        // Les marges laissent la place aux ETIQUETTES, qui debordent des
        // pastilles. La droite est reservable a part : l'arbre couche y ecrit
        // le nom de chaque feuille.
        // La gauche est reservable a part, comme la droite : un tronc pose au
        // ras de la marge ecrit son nom CENTRE dessous, et la moitie du nom
        // sort du cadre (mesure : -3 px sur un sujet de 24 signes, dernier
        // niveau d'un bosquet avec aile de convergence).
        const padL = Math.max(76, raw.padLeft || 0), padY = 34;
        const padR = Math.max(76, raw.padRight || 0);
        const spanX = Math.max(1e-6, bb.maxX - bb.minX);
        const spanY = Math.max(1e-6, bb.maxY - bb.minY);
        // Plafond d'agrandissement : les rayons ne suivent pas l'echelle, donc
        // grandir n'ecarte que les positions. L'index, qui tient en quelques
        // cellules, a le droit de s'etaler davantage — sinon quatre pastilles
        // se serrent au milieu d'un cadre vide. L'arbre, lui, reste serre : ses
        // feuilles portent leur nom, et les ecarter les couperait du tronc.
        const cap = raw.maxScale || 1.35;
        const scale = Math.max(0.08, Math.min((cssW - padL - padR) / spanX,
            (cssH - padY * 2) / spanY, cap));
        // Centre du cadre UTILE (marges retirees), pas du canvas : sinon la
        // reserve de droite deplacerait tout le dessin vers la droite.
        const offX = padL + (cssW - padL - padR) / 2 - ((bb.minX + bb.maxX) / 2) * scale;
        const offY = cssH / 2 - ((bb.minY + bb.maxY) / 2) * scale;
        raw.nodes.forEach((n) => { n.x = n.x * scale + offX; n.y = n.y * scale + offY; });
        raw.titles.forEach((t) => { t.x = t.x * scale + offX; t.y = t.y * scale + offY; });
        const bl = raw.baseline;
        if (bl) {
            bl.y = bl.y * scale + offY;
            bl.x0 = bl.x0 * scale + offX;
            bl.x1 = bl.x1 * scale + offX;
        }
        return { nodes: raw.nodes, edges: raw.edges, titles: raw.titles,
            baseline: bl, scale: scale, kept: raw.nodes.length };
    },

    // =====================================================================
    //  Trace
    // =====================================================================

    _paintGraph() {
        const cv = this._graphCanvas;
        if (!cv || !cv.isConnected) return;
        const ctx = cv.getContext ? cv.getContext('2d') : null;
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const cssW = cv.clientWidth || 640;
        const cssH = cv.clientHeight || 460;
        const pw = Math.max(1, Math.round(cssW * dpr));
        const ph = Math.max(1, Math.round(cssH * dpr));
        if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const L = this._graphBuild(cssW, cssH);
        this._graphLayout = L;
        if (!L) return;

        // Tokens relus MAINTENANT : les deux modes sortent justes.
        const mono = this._tok('--font-mono') || 'ui-monospace, monospace';
        const border = this._tok('--border') || '#1C2947';
        const dim = this._tok('--text-dim') || '#5A6C90';
        const muted = this._tok('--text-muted') || '#8FA3C4';
        const fg = this._tok('--text') || '#EDF2FA';
        // Le lisere des pastilles doit etre le fond REEL de la toile — c'est
        // --bg-elev-2 que porte .paper-graph, pas la surface des cartes.
        const bg = this._tok('--bg-elev-2') || '#0E1526';

        const hov = this._graphHover;
        const hi = (hov === null || hov === undefined) ? -1 : hov;
        // Voisinage du noeud survole : lui et ses aretes restent nets, le reste
        // s'estompe. C'est la seule facon de suivre un fil dans une toile dense.
        const near = {};
        if (hi >= 0) {
            near[hi] = 1;
            L.edges.forEach((e) => {
                if (e.a === hi) near[e.b] = 1;
                if (e.b === hi) near[e.a] = 1;
            });
        }
        const lit = (i) => (hi < 0 || near[i]);

        // --- la ligne de base : le sol sur lequel les troncs sont poses ---
        if (L.baseline) {
            ctx.globalAlpha = (hi >= 0) ? 0.14 : 0.38;
            ctx.strokeStyle = border;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(L.baseline.x0, L.baseline.y);
            ctx.lineTo(L.baseline.x1, L.baseline.y);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // --- branches et liens : beziers organiques, depart DANS l'axe ---
        //
        // Chaque noeud porte sa direction de POUSSE (gx, gy) : la courbe quitte
        // le tronc dans son axe et arrive au rameau dans le sien. C'est ce qui
        // remplace le coude sec d'un trait droit — et c'est deterministe, la
        // direction vient de la disposition, jamais d'un tirage.
        const stroke = (e) => {
            const A = L.nodes[e.a], B = L.nodes[e.b];
            if (!A || !B) return;
            const dx = B.x - A.x, dy = B.y - A.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            ctx.beginPath();
            ctx.moveTo(A.x, A.y);
            if (e.cross) {
                // Fil lointain (une tendance vers son titre) : courbure douce,
                // dont le SENS vient de la parite des index — pas d'un tirage.
                const bend = Math.min(52, len * 0.16) * (((e.a + e.b) % 2) ? 1 : -1);
                ctx.quadraticCurveTo((A.x + B.x) / 2 + (-dy / len) * bend,
                    (A.y + B.y) / 2 + (dx / len) * bend, B.x, B.y);
            } else {
                const d1 = Math.min(96, len * 0.46), d2 = Math.min(76, len * 0.34);
                ctx.bezierCurveTo(A.x + A.gx * d1, A.y + A.gy * d1,
                    B.x - B.gx * d2, B.y - B.gy * d2, B.x, B.y);
            }
            ctx.stroke();
        };

        L.edges.forEach((e) => {
            const on = (hi < 0) ? false : (e.a === hi || e.b === hi);
            const faded = (hi >= 0 && !on);
            const s = this._gtype(e.sentiment);
            // Une arete de STRUCTURE (tronc -> rameau) ne porte aucun jugement :
            // elle reste le trait de la grille, quoi qu'en dise la donnee.
            const col = e.struct ? border
                : (Object.prototype.hasOwnProperty.call(this._GEDGE, s)
                    ? (this._tok(this._GEDGE[s]) || border) : border);
            const dash = Object.prototype.hasOwnProperty.call(this._GEDGE_DASH,
                this._gtype(e.type));
            // Un fil de CONVERGENCE traverse tout le cadre : au repos il se
            // tient en retrait (une dizaine de longues courbes a pleine encre
            // mangeraient le dessin), sous le curseur il s'allume comme les
            // autres — c'est la, et seulement la, qu'on veut le suivre.
            const rest = e.struct ? 0.5
                : (e.cross ? 0.2 : (e.conv ? 0.24 : 0.36));
            ctx.globalAlpha = faded ? 0.07 : (on ? 0.92 : rest);
            ctx.strokeStyle = col;
            ctx.lineWidth = e.struct ? (on ? 2.6 : 2) : (on ? 1.9 : 1);
            // Bout CARRE sur un pointille : un bout rond rallonge chaque tiret
            // de la moitie de l'epaisseur des DEUX cotes et rebouche les vides —
            // le trait redevient plein a l'oeil (mesure : 89 % de couverture au
            // lieu de 60 %). Le bout rond ne sert donc que sur un trait plein.
            ctx.lineCap = dash ? 'butt' : 'round';
            ctx.setLineDash(dash ? [3.5, 4.5] : []);
            stroke(e);
        });
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // --- titres de bosquet (« Tendances Reddit ») ---
        if (L.titles.length) {
            ctx.font = '600 11px ' + mono;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = dim;
            ctx.globalAlpha = (hi >= 0) ? 0.4 : 1;
            L.titles.forEach((t) => { ctx.fillText(t.text, t.x, t.y); });
            ctx.globalAlpha = 1;
        }

        // --- les noeuds ---
        ctx.textBaseline = 'middle';
        const labels = [];
        L.nodes.forEach((n, i) => {
            const on = lit(i);
            const col = this._gNodeColor(n);
            ctx.globalAlpha = on ? 1 : 0.2;
            // Le SUJET n'est pas un point : c'est une PASTILLE rectangulaire
            // qui porte son nom DEDANS. Un disque de plus se lirait comme une
            // information de plus, alors qu'il n'en est pas une — il en range.
            if (n.kind === 'theme') {
                this._paintTheme(ctx, n, col, mono, on, i === hi);
                if (n.label) labels.push({ n: n, i: i, on: on, strong: false, theme: true });
                return;
            }
            // Halo du noeud vise : il se voit sans changer sa taille (donc sans
            // deplacer la cible sous le curseur).
            if (i === hi) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2);
                ctx.fillStyle = col;
                ctx.globalAlpha = 0.2;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
            if (n.kind === 'agg' || n.kind === 'card'
                || n.kind === 'fam' || n.kind === 'sub') {
                // ANNEAU, pas disque : ni l'agregat ni la carte d'un bosquet ne
                // sont une information — ce sont des COMPTEURS. Le creux les
                // separe a l'oeil de tout ce qui, autour, en est une.
                ctx.globalAlpha = on ? (n.kind === 'agg' ? 0.16 : 0.24) : 0.08;
                ctx.fillStyle = col;
                ctx.fill();
                ctx.globalAlpha = on ? (n.kind === 'agg' ? 0.62 : 1) : 0.2;
                ctx.strokeStyle = col;
                ctx.lineWidth = 2;
                ctx.stroke();
            } else if (n.type === 'watchlist') {
                // Un favori est un titre PAS ENCORE tenu : meme accent que la
                // position, mais evide. L'argent engage garde le disque plein.
                ctx.globalAlpha = on ? 0.4 : 0.12;
                ctx.fillStyle = col;
                ctx.fill();
                ctx.globalAlpha = on ? 1 : 0.2;
                ctx.strokeStyle = col;
                ctx.lineWidth = 2;
                ctx.stroke();
            } else {
                // Une info NEUTRE (une depeche qui n'annonce ni bonne ni
                // mauvaise nouvelle) garde la couleur de sa SOURCE — une breve
                // de presse reste cyan — mais en retrait : elle est la, elle ne
                // crie pas. Une nouvelle jugee, elle, garde tout son eclat.
                const soft = Object.prototype.hasOwnProperty.call(this._GSENT_SOFT,
                    this._gtype(n.sentiment));
                ctx.globalAlpha = on ? (soft ? 0.5 : 1) : (soft ? 0.12 : 0.2);
                ctx.fillStyle = col;
                ctx.fill();
                ctx.globalAlpha = on ? 1 : 0.2;
                // Un lisere de fond detache la pastille de l'arete qui passe
                // dessous.
                ctx.strokeStyle = bg;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;

            // Le VERDICT d'une hypothese, en pastille, du cote oppose a son
            // etiquette : vert = vu juste, rouge = vu faux, gris = indecidable.
            // Il est aussi ecrit en toutes lettres dans l'infobulle — une
            // couleur seule ne se lit pas.
            if (n.outcome) {
                ctx.globalAlpha = on ? 1 : 0.2;
                ctx.beginPath();
                ctx.arc(n.x - n.r - 7, n.y, 3.2, 0, Math.PI * 2);
                ctx.fillStyle = this._tok(this._GHYP_OUT[n.outcome][0]) || muted;
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // Qui porte son nom a l'ecran ? Les TRONCS et les CARTES toujours
            // (l'index n'est QUE ca), les tendances aussi ; l'AGREGAT toujours,
            // parce que c'est un compteur — le masquer rendrait invisible la
            // coupe du serveur ; les rameaux et les feuilles de l'arbre deplie
            // quand l'echelle laisse la place ; une feuille sans cote impose
            // uniquement sous le curseur, son titre entier etant dans
            // l'infobulle — l'ecrire partout ferait un mur.
            // Une FAMILLE et un SUJET de bosquet sont des cibles de navigation :
            // sans leur nom a l'ecran il n'y a rien a viser. Ils portent donc
            // toujours leur etiquette, comme un tronc.
            const strong = (n.kind === 'anchor' || n.kind === 'card'
                || n.kind === 'trend' || n.kind === 'pivot' || n.kind === 'fam');
            let show = false;
            if (i === hi) show = true;
            else if (strong || n.kind === 'agg' || n.kind === 'sub') show = true;
            else if (n.kind === 'branch') show = (L.scale >= 0.46);
            else show = (n.labelPos !== 'none' && L.scale >= 0.46);
            if (show && n.label) labels.push({ n: n, i: i, on: on, strong: strong });
        });

        // Etiquettes en DERNIER : elles passent par-dessus les pastilles
        // voisines, jamais dessous.
        labels.forEach((it) => {
            const n = it.n;
            const hovered = (it.i === hi);
            const alpha = (hi >= 0 && !it.on) ? 0.16 : 1;
            // Un SUJET s'ecrit DANS sa pastille : meme fonte qu'a la mesure
            // (_paintTheme), sinon le texte deborderait du cadre trace.
            ctx.font = it.theme ? ('600 11px ' + mono)
                : ((it.strong ? '600 12px ' : '11px ') + mono);
            ctx.globalAlpha = alpha;
            // Un SUJET de bosquet s'ecrit en pleine encre comme les autres cibles
            // de navigation : au gris du decor, le nom de ce qu'on vient
            // d'ouvrir se lisait comme une legende (vu a l'ecran).
            ctx.fillStyle = (it.strong || hovered || it.theme || n.kind === 'sub') ? fg
                : ((n.kind === 'branch' || n.kind === 'agg') ? muted : dim);
            const text = (it.strong || n.kind === 'branch')
                ? n.label : this._gtrim(n.label, this._gLabelMax(n));
            // Une feuille sans cote impose prend celui qui la garde dans le
            // cadre : a droite dans la moitie gauche, a gauche sinon.
            let pos = n.labelPos;
            if (pos === 'none') pos = (n.x <= cssW / 2) ? 'right' : 'left';
            // L'AGREGAT et les noeuds de NAVIGATION d'un bosquet rendent leur
            // etiquette cliquable : « +71 autres » comme « Politique · 76 » sont
            // des PHRASES — c'est elles qu'on lit et qu'on vise, pas l'anneau de
            // huit pixels pose a cote. Les feuilles, elles, gardent la pastille
            // pour seule cible : rendre chaque titre cliquable ouvrirait une
            // source au moindre frolement de texte.
            if (n.kind === 'agg' || n.drillFam !== undefined) {
                n.hitBox = this._gLabelBox(ctx, n,
                    text + (n.tail ? ('  ' + n.tail) : ''), pos);
            }
            if (pos === 'center') {
                // Le nom d'un sujet, au milieu de sa pastille.
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, n.x, n.y);
            } else if (pos === 'below') {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(text, n.x, n.y + n.r + 6);
                // Les COMPTEURS sous l'etiquette : ils ne peuvent se poser
                // qu'une fois le nom ecrit, sinon ils passeraient dessus.
                this._paintCounts(ctx, n, mono, alpha, n.y + n.r + 21);
            } else if (pos === 'above') {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(text, n.x, n.y - n.r - 6);
            } else if (pos === 'left') {
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, n.x - n.r - 6, n.y);
            } else {
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, n.x + n.r + 6, n.y);
                // Le COMPTEUR d'un noeud de navigation, juste apres son nom :
                // « Politique · 76 » se lit d'un trait. Mesure prise avec la
                // fonte de l'etiquette qu'on vient d'ecrire, donc jamais un
                // chevauchement.
                if (n.tail) {
                    const wl = ctx.measureText(text).width;
                    ctx.font = '600 10px ' + mono;
                    ctx.fillStyle = muted;
                    ctx.fillText(String(n.tail), n.x + n.r + 6 + wl + 9, n.y);
                }
            }
            ctx.textBaseline = 'middle';
        });
        ctx.globalAlpha = 1;
    },

    // La pastille d'un SUJET : un rectangle arrondi, teinte de la couleur de sa
    // famille, avec son nom dedans (ecrit au passage des etiquettes, qui vient
    // apres — sinon une pastille voisine passerait par-dessus le texte).
    //
    // Rectangle et non disque A DESSEIN : le sujet n'est pas une information de
    // plus, c'est le CASIER qui range celles d'en dessous. La forme le dit sans
    // qu'on ait a l'ecrire.
    _paintTheme(ctx, n, col, mono, on, hovered) {
        ctx.font = '600 11px ' + mono;
        const text = this._gtrim(n.label, this._gLabelMax(n));
        const w = ctx.measureText(text).width + 20;
        const h = n.r * 2;
        const x0 = n.x - w / 2, y0 = n.y - h / 2;
        // La boite de visee EST la pastille : le sujet se clique sur tout son
        // rectangle, pas sur les neuf pixels de son centre.
        n.hitBox = { x0: x0, x1: x0 + w, y0: y0, y1: y0 + h };
        if (hovered) {
            ctx.globalAlpha = 0.2;
            ctx.fillStyle = col;
            this._roundRect(ctx, x0 - 5, y0 - 5, w + 10, h + 10, n.r + 4);
            ctx.fill();
        }
        ctx.globalAlpha = on ? 0.18 : 0.07;
        ctx.fillStyle = col;
        this._roundRect(ctx, x0, y0, w, h, n.r);
        ctx.fill();
        ctx.globalAlpha = on ? 0.95 : 0.2;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        this._roundRect(ctx, x0, y0, w, h, n.r);
        ctx.stroke();
        ctx.globalAlpha = 1;
    },

    // Rectangle arrondi trace a la main : ctx.roundRect n'existe pas partout,
    // et une librairie pour quatre arcs serait une dependance de trop.
    _roundRect(ctx, x, y, w, h, r) {
        const rad = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + rad, y);
        ctx.lineTo(x + w - rad, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
        ctx.lineTo(x + w, y + h - rad);
        ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
        ctx.lineTo(x + rad, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
        ctx.lineTo(x, y + rad);
        ctx.quadraticCurveTo(x, y, x + rad, y);
        ctx.closePath();
    },

    // Couleur d'une pastille. Un rameau porte celle de sa famille ; l'agregat
    // celle du bosquet qu'il resume (et le gris neutre quand ce bosquet n'a pas
    // de famille) ; une carte celle de son bosquet ; tout le reste celle de son
    // type. Aucune couleur n'est fabriquee par concatenation depuis la donnee.
    _gNodeColor(n) {
        if (n.kind === 'branch') return this._gfamColor(n.fam);
        if (n.kind === 'card') return this._gPivotColor(n.role);
        // Un sujet porte la couleur de sa bande — celle de ses feuilles. Les
        // deux etages de navigation d'un bosquet (famille, sujet) suivent la
        // meme regle : la couleur dit toujours D'OU vient ce qu'on ouvre.
        if (n.kind === 'theme' || n.kind === 'fam' || n.kind === 'sub') {
            return this._gfamColor(n.fam);
        }
        if (n.kind === 'agg') {
            return n.fam ? this._gfamColor(n.fam) : this._gcolor(n.type);
        }
        return this._gcolor(n.type);
    },

    // Longueur d'etiquette PAR TYPE : une these du radar a droit a plus de place
    // (c'est une phrase, et son bosquet en tient douze au plus), tout le reste
    // tient en trente signes.
    _gLabelMax(n) {
        // La DISPOSITION a le dernier mot quand elle a mesure la place : au
        // dernier niveau d'un bosquet, les deux ailes ecrivent l'une vers
        // l'autre et leurs plafonds viennent de la, pas du type de noeud.
        const own = (n && typeof n.labelMax === 'number' && n.labelMax > 0)
            ? n.labelMax : 0;
        if (own) return own;
        const t = this._gtype(n && n.type);
        return Object.prototype.hasOwnProperty.call(this._GLABEL_MAX, t)
            ? this._GLABEL_MAX[t] : 30;
    },

    // Les COMPTEURS sous un tronc : une pastille par famille de source presente,
    // avec son nombre. C'est ce qui REMPLACE les feuilles dans l'index — on voit
    // ou ca chauffe sans dessiner ce qui chauffe.
    //
    // Trois par rangee au plus : au-dela, deux troncs voisins se toucheraient
    // des que l'echelle baisse (le texte, lui, ne retrecit pas avec le dessin).
    _paintCounts(ctx, n, mono, alpha, yTop) {
        const list = Array.isArray(n.counts) ? n.counts : [];
        if (!list.length) return;
        const PER = 3, DOT = 3.2, GAP = 5, PAD = 10, H = 14;
        ctx.font = '600 10px ' + mono;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        for (let r = 0; r * PER < list.length; r++) {
            const row = list.slice(r * PER, r * PER + PER);
            const txt = row.map((b) => this._num(b.n, 0));
            const w = txt.map((t) => DOT * 2 + GAP + ctx.measureText(t).width + PAD);
            let total = 0;
            w.forEach((v) => { total += v; });
            let x = n.x - total / 2;
            const y = yTop + r * H + H / 2;
            row.forEach((b, j) => {
                const col = this._gBadgeColor(b);
                ctx.fillStyle = col;
                ctx.globalAlpha = alpha * 0.85;
                ctx.beginPath();
                ctx.arc(x + DOT, y, DOT, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = alpha;
                ctx.fillText(txt[j], x + DOT * 2 + GAP, y);
                x += w[j];
            });
        }
        ctx.globalAlpha = alpha;
        ctx.textBaseline = 'middle';
    },

    // Troncature a la LIMITE DE MOT quand c'est possible : « Résultats T3 dé… »
    // se lit, « Résultats T3 dép » fait croire a un mot coupe par erreur.
    _gtrim(s, max) {
        const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        if (t.length <= max) return t;
        const cut = t.slice(0, max);
        const sp = cut.lastIndexOf(' ');
        return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
    },

    // =====================================================================
    //  Pointeur : survol, tap, clic
    // =====================================================================

    _graphHit(x, y) {
        const L = this._graphLayout;
        if (!L) return -1;
        let best = -1, bestD = Infinity;
        for (let i = 0; i < L.nodes.length; i++) {
            const n = L.nodes[i];
            const dx = n.x - x, dy = n.y - y;
            const d = dx * dx + dy * dy;
            const reach = n.r + 8;
            if (d <= reach * reach && d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) return best;
        // Rattrapage : l'ETIQUETTE d'un agregat est une cible a part entiere.
        // « +71 autres » est une PHRASE — c'est elle qu'on lit et qu'on vise,
        // pas l'anneau de six pixels pose a cote. La boite est mesuree au trace
        // (_paintGraph), donc elle suit exactement le texte affiche.
        //
        // En SECOND passage seulement : une pastille voisine, qui se vise au
        // pixel pres, ne doit jamais se faire voler son clic par une boite de
        // texte large de deux cents pixels.
        for (let i = 0; i < L.nodes.length; i++) {
            const b = L.nodes[i].hitBox;
            if (b && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return i;
        }
        return -1;
    },

    // Boite de l'etiquette d'un noeud, dans le repere du canvas. Le texte vient
    // d'etre mesure avec la police COURANTE de ctx (l'appel se fait juste avant
    // fillText), donc la boite colle au rendu et non a une estimation.
    _gLabelBox(ctx, n, text, pos) {
        const w = ctx.measureText(String(text == null ? '' : text)).width;
        const H = 15;                       // hauteur de ligne du 11 px mono
        if (pos === 'left') {
            return { x0: n.x - n.r - 6 - w, x1: n.x - n.r - 6,
                y0: n.y - H / 2, y1: n.y + H / 2 };
        }
        if (pos === 'above') {
            return { x0: n.x - w / 2, x1: n.x + w / 2,
                y0: n.y - n.r - 6 - H, y1: n.y - n.r - 6 };
        }
        if (pos === 'below') {
            return { x0: n.x - w / 2, x1: n.x + w / 2,
                y0: n.y + n.r + 6, y1: n.y + n.r + 6 + H };
        }
        return { x0: n.x + n.r + 6, x1: n.x + n.r + 6 + w,
            y0: n.y - H / 2, y1: n.y + H / 2 };
    },

    // Le repeint est groupe par requestAnimationFrame : un survol traverse des
    // dizaines de pixels par seconde, et redessiner a chaque pixel bloquerait
    // le fil pour rien. AUCUNE boucle continue — on ne peint que sur evenement.
    _graphQueuePaint() {
        if (this._graphRaf) return;
        this._graphRaf = window.requestAnimationFrame(() => {
            this._graphRaf = 0;
            this._paintGraph();
            this._paintGraphTip();
        });
    },

    _mountGraph() {
        const cv = document.querySelector('#paper-body canvas[data-paper-graph]');
        if (!cv) return;
        this._graphCanvas = cv;
        const at = (ev) => {
            const rect = cv.getBoundingClientRect();
            return this._graphHit(ev.clientX - rect.left, ev.clientY - rect.top);
        };
        const setHover = (i) => {
            const v = (i >= 0) ? i : null;
            if (v === this._graphHover) return;
            this._graphHover = v;
            this._graphQueuePaint();
        };
        const onMove = (ev) => {
            if (ev.pointerType === 'touch') return;   // le doigt TAPE, il ne survole pas
            const i = at(ev);
            setHover(i);
            cv.style.cursor = (i >= 0) ? 'pointer' : 'default';
        };
        const onLeave = (ev) => {
            if (ev && ev.pointerType === 'touch') return;
            setHover(-1);
        };
        // Le tap sert d'abord a LIRE : il pose le survol (donc l'infobulle).
        const onDown = (ev) => { if (ev.pointerType === 'touch') setHover(at(ev)); };
        const onClick = (ev) => {
            const i = at(ev);
            if (i < 0) return;
            ev.preventDefault();
            this._graphActivate(i);
        };
        cv.addEventListener('pointermove', onMove);
        cv.addEventListener('pointerdown', onDown);
        cv.addEventListener('pointerleave', onLeave);
        cv.addEventListener('click', onClick);
        this._onGraphResize = () => {
            if (this._graphResizeTimer) clearTimeout(this._graphResizeTimer);
            this._graphResizeTimer = setTimeout(() => {
                this._graphResizeTimer = null;
                this._graphHover = null;
                this._paintGraph();
                this._paintGraphTip();
            }, 120);
        };
        window.addEventListener('resize', this._onGraphResize);
        // Un SECOND trace au tour suivant. Mesure : monte alors que la mise en
        // page n'est pas encore faite, clientWidth vaut 0, on retombe sur la
        // taille de repli (640) — la toile est alors calculee pour un cadre qui
        // n'existe pas, le bitmap est etire par le CSS (pastilles ovales) et les
        // etiquettes de droite se font couper. Le tour suivant, la boite est
        // connue. Groupe par requestAnimationFrame, donc jamais deux fois, et
        // annule par _disposeGraph : aucune boucle continue.
        this._graphQueuePaint();
        cv._paperGraphOff = () => {
            cv.removeEventListener('pointermove', onMove);
            cv.removeEventListener('pointerdown', onDown);
            cv.removeEventListener('pointerleave', onLeave);
            cv.removeEventListener('click', onClick);
        };
        this._paintGraph();
        this._paintGraphTip();
    },

    _disposeGraph() {
        const cv = this._graphCanvas;
        if (cv && cv._paperGraphOff) { cv._paperGraphOff(); cv._paperGraphOff = null; }
        this._graphCanvas = null;
        this._graphLayout = null;
        if (this._onGraphResize) {
            window.removeEventListener('resize', this._onGraphResize);
            this._onGraphResize = null;
        }
        if (this._graphResizeTimer) { clearTimeout(this._graphResizeTimer); this._graphResizeTimer = null; }
        if (this._graphRaf) { window.cancelAnimationFrame(this._graphRaf); this._graphRaf = 0; }
    },

    // Clic sur un noeud : une ANCRE deplie l'arbre de son titre (une requete au
    // serveur), une CARTE deplie le bosquet dans la toile deja chargee (aucune
    // requete), un AGREGAT ouvre la liste complete de son bosquet (une requete),
    // un noeud d'information ouvre sa source quand il en a une. Un noeud sans
    // lien ne fait rien — mais il a deja tout dit dans son infobulle.
    _graphActivate(i) {
        const L = this._graphLayout;
        const n = L && L.nodes[i];
        if (!n) return;
        // Un noeud de BOSQUET dit lui-meme ou il mene : descendre d'un cran
        // (famille, puis sujet) ou, pour le tronc, remonter. Un chemin qui ne
        // change rien ne redessine rien — le tronc du premier niveau est donc
        // muet, ce qui est exact : il n'y a rien au-dessus de lui.
        if (n.drillFam !== undefined) {
            this.drillTo(n.drillFam, n.drillTheme, n.drillSub);
            return;
        }
        if (n.kind === 'card') {
            if (this._graphPivot === n.id) return;    // deja deplie
            this.focusPivot(n.id);
            return;
        }
        // « +71 autres » etait un cul-de-sac : il annoncait une masse et la
        // cachait. Il OUVRE desormais cette masse, en liste, sous la toile.
        if (n.kind === 'agg') { this.openGrove(n.grove); return; }
        // Un SUJET de bosquet ouvre la meme liste : elle est rangee par ces
        // memes sujets, donc on y retrouve le sien en tete de section. Un sujet
        // de TITRE (qui n'a pas de bosquet) ne fait rien — il a deja tout dit
        // dans son infobulle.
        if (n.kind === 'theme') { if (n.grove) this.openGrove(n.grove); return; }
        if (n.anchor) {
            if (this._graphSymbol === n.id) return;   // deja rapproche sur lui
            this.loadGraph(n.id);
            return;
        }
        if (!n.link) return;
        // _safeUrl a deja ecarte tout ce qui n'est pas http(s) a la construction.
        window.open(n.link, '_blank', 'noopener,noreferrer');
    },

    // --------------------------------------------------------------- infobulle

    _paintGraphTip() {
        const tip = document.getElementById('paper-graph-tip');
        if (!tip) return;
        const L = this._graphLayout;
        const i = this._graphHover;
        const n = (L && i !== null && i !== undefined) ? L.nodes[i] : null;
        if (!n) { tip.style.display = 'none'; tip.innerHTML = ''; return; }

        // La carte d'un bosquet ne repete pas son type : les trois sont des
        // pivots « contexte » cote serveur, et l'ecrire sous « Radar » dirait
        // « Contexte mondial » — un contresens.
        // Un SUJET ne repete pas son type non plus : son nom EST son sujet, et
        // « Sujet » ecrit sous « Canada · Tariffs » n'apprend rien.
        // Les etages de navigation d'un bosquet (famille, sujet) ne repetent pas
        // leur type non plus : leur nom EST leur nature.
        const type = (n.kind === 'card' || n.kind === 'theme'
            || n.kind === 'fam' || n.kind === 'sub')
            ? '' : this._gtypeLabel(n.type);
        const when = (n.ts === undefined || n.ts === null || n.ts === '')
            ? '' : this._dateShort(n.ts);
        const bits = [];
        if (type) bits.push(type);
        if (when && when !== '—') bits.push(when);
        // Lignes DEJA redigees par la disposition (« 12 mentions 24 h (avant :
        // 5) » d'une tendance, « 4 elements » d'un rameau). Quand il y en a, la
        // lecture brute de meta est SAUTEE : afficher les deux dirait deux fois
        // la meme chose, une fois en francais et une fois en nom de champ.
        let metaHtml = '';
        const lines = Array.isArray(n.lines) ? n.lines : [];
        // Le DETAIL des compteurs d'un tronc : « Presse 12 », « Politique 3 ».
        // C'est la contrepartie de l'index — la pastille dit combien, l'infobulle
        // dit de quoi. Sept familles au plus, donc pas de troncature a inventer.
        const counts = Array.isArray(n.counts) ? n.counts : [];
        if (counts.length) {
            // Une carte n'a qu'un compteur, et son nom est deja en tete : la
            // ligne dit « elements », pas une seconde fois le nom du bosquet.
            const own = (n.kind === 'card' || n.kind === 'fam' || n.kind === 'sub');
            metaHtml = counts.map((b) =>
                '<div class="paper-graph-tip-meta">' +
                '<span>' + esc(this._gtrim(own
                    ? Lang.t('paper.graph_items') : this._gBadgeLabel(b), 22)) + '</span>' +
                '<span>' + esc(this._num(b.n, 0)) + '</span></div>').join('');
        } else if (lines.length) {
            metaHtml = lines.slice(0, 3).map((t) =>
                '<div class="paper-graph-tip-sub">' + esc(this._gtrim(String(t), 60)) +
                '</div>').join('');
        } else if (n.meta) {
            // meta : lecture DEFENSIVE. On n'affiche que des paires plates et
            // courtes, et JAMAIS plus de 4 — la donnee vient du serveur, elle
            // n'a pas a decider de la taille de l'infobulle.
            metaHtml = Object.keys(n.meta).slice(0, 4).map((k) => {
                const v = n.meta[k];
                if (v === null || v === undefined || typeof v === 'object') return '';
                return '<div class="paper-graph-tip-meta">' +
                    '<span>' + esc(this._gtrim(k, 22)) + '</span>' +
                    '<span>' + esc(this._gtrim(String(v), 46)) + '</span></div>';
            }).join('');
        }
        tip.innerHTML =
            '<div class="paper-graph-tip-head">' + esc(n.label) + '</div>' +
            (bits.length ? '<div class="paper-graph-tip-sub">' + esc(bits.join(' · ')) + '</div>' : '') +
            metaHtml +
            // Un noeud de bosquet DIT lui-meme ce que son clic fait : c'est la
            // disposition qui l'a decide, pas l'infobulle qui le devine.
            (n.cta
              ? '<div class="paper-graph-tip-cta">' + esc(Lang.t(n.cta)) + '</div>'
              : (n.kind === 'card'
              ? '<div class="paper-graph-tip-cta">' + esc(Lang.t('paper.graph_open_grove')) + '</div>'
              // L'agregat DIT desormais qu'il s'ouvre : sans cette ligne, un
              // anneau qui compte 71 elements se lit comme un cul-de-sac, et
              // personne n'essaie de cliquer dessus. Il ne la porte que s'il
              // sait DE QUEL bosquet il compte le reste.
              : (((n.kind === 'agg' || n.kind === 'theme') && n.grove)
                ? '<div class="paper-graph-tip-cta">' + esc(Lang.t('paper.graph_agg_open')) + '</div>'
                : (n.anchor
                  ? '<div class="paper-graph-tip-cta">' + esc(Lang.t('paper.graph_focus')) + '</div>'
                  : (n.link
                      ? '<div class="paper-graph-tip-cta">' + esc(Lang.t('paper.graph_link')) + '</div>'
                      : '')))));

        // Placement : a droite du noeud par defaut, bascule a gauche quand il
        // n'y a plus la place. L'infobulle ne sort jamais du cadre.
        tip.style.display = 'block';
        const host = tip.parentNode;
        const W = (host && host.clientWidth) || 0;
        const H = (host && host.clientHeight) || 0;
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let x = n.x + n.r + 12;
        if (x + tw > W - 6) x = n.x - n.r - 12 - tw;
        if (x < 6) x = 6;
        let y = n.y - th / 2;
        if (y < 6) y = 6;
        if (y + th > H - 6) y = Math.max(6, H - 6 - th);
        tip.style.left = Math.round(x) + 'px';
        tip.style.top = Math.round(y) + 'px';
    },

    // =====================================================================
    //  La vue
    // =====================================================================

    _viewGraph() {
        const nodes = this._graphNodes();
        const g = this._graph;
        const ego = this._graphSymbol;
        const root = this._graphRootId();

        // Rangee de filtres : « Tout » puis les ancres relevees. Elle reste la
        // meme quand un sujet est deplie — c'est ce qui permet de sauter d'un
        // titre a l'autre sans repasser par l'index.
        const pills = '<button class="paper-tab' + (root ? '' : ' active') + '" ' +
                'data-paper-act="graph-all">' + esc(Lang.t('paper.graph_all')) + '</button>' +
            this._graphAnchors.map((a) =>
                '<button class="paper-tab' + (ego === a.id ? ' active' : '') + '" ' +
                    'data-paper-act="graph-focus" data-sym="' + esc(a.id) + '">' +
                  esc(a.label) + '</button>').join('');

        // Un BOSQUET ouvert se lit par niveaux, sur sa propre liste : le fil
        // d'Ariane dit ou l'on est, et la toile ne dessine QUE le niveau courant.
        const gk = this._groveKindOf(this._graphPivot);
        const D = gk ? this._drillPlan(this._graphPivot) : null;
        const crumbs = D ? this._drillCrumbs(D) : '';

        let body;
        if (this._graphLoading && !nodes.length) {
            body = this._muted(Lang.t('paper.graph_loading'));
        } else if (!nodes.length) {
            body = this._muted(Lang.t('paper.graph_empty'));
        } else if (gk && !this._groveOf(gk)) {
            // Le bosquet est ouvert mais sa liste n'est pas encore la : on le
            // DIT, plutot que de dessiner un tronc nu qui se lirait « vide ».
            body = crumbs + this._muted(Lang.t((this._groveLoading === gk)
                ? 'paper.grove_loading' : 'paper.grove_empty'));
        } else {
            body = crumbs +
                  '<div class="paper-graph-wrap">' +
                    '<canvas data-paper-graph="1" class="paper-graph"></canvas>' +
                    '<div id="paper-graph-tip" class="paper-graph-tip"></div>' +
                  '</div>' +
                  this._graphLegend(root, D) +
                  // L'aile de convergence DIT ce qu'elle est : sans cette
                  // ligne, une dizaine de points colles au bord droit se
                  // lisent comme un decor, pas comme « d'autres sources
                  // parlent du meme sujet ».
                  ((D && D.level === 4 && D.cross.length)
                    ? '<div class="paper-graph-note">' +
                        esc(Lang.t('paper.gconv_note') +
                          // …et ce que l'aile ne montre pas. La liste dessous
                          // porte le sujet de la famille ouverte, pas ce que
                          // les autres en disent : ce plafond-la n'a personne
                          // d'autre pour le dire.
                          (D.crossHidden
                            ? (' ' + this._num(D.crossHidden, 0) + ' ' +
                               Lang.t('paper.graph_agg_tip') + '.')
                            : '')) +
                      '</div>'
                    : '') +
                  // Le serveur DIT quand il a rogne ce qu'il envoie. On le
                  // repete tel quel : plus aucun plafond de dessin cote client
                  // ne s'y ajoute, donc ce message ne peut venir que de lui.
                  ((g && g.truncated && !gk)
                    ? '<div style="font-size:12px;color:var(--text-dim);margin-top:8px;">' +
                        esc(Lang.t('paper.graph_truncated') + ' ' +
                            this._num(nodes.length, 0) + ' ' + Lang.t('paper.graph_nodes')) +
                      '</div>'
                    : '') +
                  // Au dernier niveau d'un bosquet, la liste du sujet s'ouvre
                  // TOUTE SEULE sous la toile : le canvas montre les plus
                  // recentes, elle les porte toutes. Ailleurs (arbre d'un titre),
                  // c'est l'agregat qui deplie la liste plate de son bosquet.
                  (D ? this._drillList(D) : this._groveCard());
        }

        // L'entete dit CE QU'ON REGARDE : l'index, l'arbre d'un titre, ou —
        // dans un bosquet — ce que le niveau courant attend du lecteur (son NOM,
        // lui, est deja en tete du fil d'Ariane : le repeter serait du bruit).
        let hint = Lang.t('paper.graph_hint');
        if (D) hint = this._drillHint(D);
        else if (this._graphPivot) hint = this._graphGroveLabel();
        else if (ego) hint = Lang.t('paper.graph_ego') + ' ' + ego;

        return this._card(
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
              '<h3 style="margin:0;font-size:17px;">' + esc(Lang.t('paper.graph_title')) + '</h3>' +
              '<span style="font-size:12px;color:var(--text-dim);">' + esc(hint) + '</span>' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="graph-reload" ' +
                  'style="margin-left:auto;">' + esc(Lang.t('paper.refresh')) + '</button>' +
            '</div>' +
            '<div class="paper-tabs">' + pills + '</div>' +
            body
        );
    },

    // Nom TRADUIT du bosquet deplie, reconnu par sa forme dans la toile
    // courante. Le nom que le serveur envoie est en francais : on ne l'affiche
    // pas, on le retrouve par le role.
    _graphGroveLabel() {
        const id = String(this._graphPivot == null ? '' : this._graphPivot);
        if (!id) return '';
        // Les trois bosquets connus se nomment par leur whitelist — sans avoir a
        // relire la toile pour retrouver leur forme.
        const k = this._groveKindOf(id);
        if (k) return this._gPivotLabel(this._groveRole(k));
        const P = this._graphParts(this._graphNodes());
        return this._gPivotLabel(P.roleOf[id] || 'world');
    },

    // La legende dit la meme chose que la toile, dans le meme ordre : une
    // pastille par FAMILLE DE SOURCE (le nœud dit d'ou vient l'info), puis une
    // ligne pour les LIENS (le lien dit ce que l'info raconte). Cette derniere
    // ligne ne parait QUE quand des liens sont dessines : l'index n'en a aucun,
    // et expliquer la couleur d'un trait absent est un contresens.
    //
    // Dans un BOSQUET, la legende se lit sur le niveau COURANT et non sur la
    // toile entiere : c'est la seule facon qu'elle nomme les familles qu'on a
    // reellement sous les yeux — a commencer par celles qui convergent depuis
    // le bord droit, que la toile globale, elle, ne dessine pas.
    _graphLegend(root, D) {
        if (D && D.kind) {
            return this._legendHtml(this._drillLegendFams(D), [],
                Lang.t('paper.graph_legend_edges'));
        }
        const seen = {};
        this._graphNodes().forEach((n) => { seen[this._gtype(n.type)] = 1; });
        const famSeen = {};
        Object.keys(seen).forEach((t) => {
            if (!this._isGraphType(t)) return;
            const f = this._gfam(t);
            if (f) famSeen[f] = 1;
        });
        const fams = this._GFAM_ORDER.filter((f) => famSeen[f]);
        // Un type hors table figure quand meme dans la legende — en pastille
        // neutre et sous son propre nom : on ne cache pas ce qu'on ne sait pas
        // nommer, et on n'invente pas de famille pour lui.
        const others = Object.keys(seen).filter((t) => !this._isGraphType(t)).sort();
        return this._legendHtml(fams, others,
            root ? Lang.t('paper.graph_legend_edges') : Lang.t('paper.graph_legend_index'));
    },

    // Les familles DESSINEES au niveau courant d'un bosquet, dans l'ordre fixe
    // de la legende. PUR : le meme plan rend la meme liste.
    _drillLegendFams(D) {
        if (D.level === 1) return D.fams;
        const seen = {};
        if (D.fam) seen[D.fam] = 1;
        // Au dernier niveau, l'aile de convergence amene d'AUTRES familles :
        // sans elles, la legende laisserait des couleurs sans nom a l'ecran.
        if (D.level === 4) {
            D.cross.forEach((n) => { seen[this._drillFamOf(n)] = 1; });
        }
        return this._GFAM_ORDER.filter((f) =>
            Object.prototype.hasOwnProperty.call(seen, f));
    },

    _legendHtml(fams, others, note) {
        const item = (color, label) =>
            '<span class="paper-graph-key">' +
              '<i style="background:' + esc(color) + ';"></i>' +
              esc(label) + '</span>';
        const neutral = this._tok('--text-dim') || '#8FA3C4';
        return '<div class="paper-graph-legend">' +
            fams.map((f) => item(this._gfamColor(f), this._gfamLabel(f))).join('') +
            others.map((t) => item(neutral, t)).join('') +
        '</div>' +
        '<div class="paper-graph-note">' + esc(note) + '</div>';
    },

    // =====================================================================
    //  Le signal : « ce titre a deja des connexions »
    // =====================================================================
    //
    // Regle dure, la meme que la memoire du coach : zero connexion => AUCUN
    // element a l'ecran. Un compteur a 0 est du bruit, et un encart vide
    // apprend a ignorer l'encart.

    async _loadGraphCount(symbol) {
        const sym = String(symbol || '');
        if (!sym) return;
        const d = await this._get('/api/paper/graph/count?symbol=' + encodeURIComponent(sym));
        const n = this._n(d && d.count);
        this._graphCounts[sym] = (n === null || n < 0) ? 0 : Math.floor(n);
        if (!this._graphCounts[sym]) return;      // rien a dire : on ne dessine rien
        // Le chip ne vit que dans ces deux vues : ailleurs, rien a redessiner.
        if (this._tab === 'trade' || this._tab === 'portfolio') this._renderBody();
    },

    // Pastille de la rangée de filtres : « Tout » (null) ou une ancre.
    // « Tout » referme AUSSI un bosquet déplié — sans quoi le bouton n'aurait
    // aucun effet visible quand on regarde le monde ou le radar.
    focusGraph(symbol) {
        const sym = (symbol === null || symbol === undefined || symbol === '') ? null : String(symbol);
        if (sym === null && this._graphPivot !== null && this._graphSymbol === null) {
            this._graphPivot = null;
            this._graphHover = null;
            this._closeGrove();
            this._renderBody();
            return;
        }
        if (sym === this._graphSymbol) return;
        this.loadGraph(sym);
    },

    // Clic sur la carte d'un bosquet : on l'OUVRE, au premier niveau — ses
    // familles de source. La liste entière du bosquet est lue ici, UNE fois
    // (gardée ensuite) : c'est elle, et non les douze satellites du dessin, qui
    // porte les comptes de tous les niveaux.
    focusPivot(id) {
        const pid = (id === null || id === undefined || id === '') ? null : String(id);
        if (pid === this._graphPivot) return;
        this._graphPivot = pid;
        this._graphHover = null;
        // La liste ouverte est celle d'un AUTRE bosquet : la garder sous la
        // toile ferait lire les 83 dépêches du monde sous le titre du radar.
        this._closeGrove();
        this._renderBody();
        const k = this._groveKindOf(pid);
        if (k) this._groveFetch(k, false);
    },

    // =====================================================================
    //  Le bosquet PAR NIVEAUX — familles > sujets > dépêches
    // =====================================================================
    //
    // Ouvrir un bosquet donnait un arc de douze points anonymes et un anneau
    // « +64 autres » qui annonçait une masse en la cachant (retour utilisateur
    // du 26/08, capture à l'appui). On DESCEND maintenant : les familles de
    // source, puis les sujets de celle qu'on ouvre, puis ses dépêches — le
    // canvas montre les plus récentes, la liste dépliée dessous les porte
    // TOUTES. Plus aucun agrégat sur ce chemin : il n'a plus rien à résumer.
    //
    // Tout se calcule sur la liste ENTIÈRE du bosquet (/graph/grove, lue une
    // fois et gardée). Le chemin ouvert vit en CLÉS (_drillFam,
    // _drillTheme), jamais en libellés : changer de langue retraduit l'écran
    // sans déplacer d'un cran ce qu'on regarde.

    // Identifiant de pivot -> « kind » de l'endpoint, par whitelist FERMÉE. Rien
    // ne repart vers le serveur qu'on n'ait d'abord reconnu.
    _groveKindOf(pivotId) {
        const k = String(pivotId == null ? '' : pivotId);
        return Object.prototype.hasOwnProperty.call(this._GROVE_KIND, k)
            ? this._GROVE_KIND[k] : '';
    },

    _groveRole(kind) {
        const k = String(kind == null ? '' : kind);
        return Object.prototype.hasOwnProperty.call(this._GROVE_ROLE, k)
            ? this._GROVE_ROLE[k] : 'world';
    },

    // Le CHEMIN se referme ; le cache, lui, survit — c'est un cache, pas un
    // état d'écran. Seul « Actualiser » le jette (cf. _groveFetch).
    _closeGrove() {
        this._groveOpen = null;
        this._drillFam = '';
        this._drillTheme = '';
        this._drillSub = '';
    },

    closeGrove() {
        this._closeGrove();
        this._renderBody();
    },

    // La liste d'un bosquet, lue UNE fois. Le drapeau « force » la relit
    // (bouton Actualiser) — sans lui, deux allers-retours au même bosquet
    // dans la même minute referaient la même requête pour la même réponse.
    async _groveFetch(kind, force) {
        const k = this._groveKindOf(kind);
        // Bosquet non reconnu : aucune requête. Un aller-retour pour un 400 ne
        // dirait rien de plus à l'écran qu'une carte qui ne réagit pas.
        if (!k) return;
        if (!force && Object.prototype.hasOwnProperty.call(this._groveCache, k)) return;
        if (force) delete this._groveCache[k];
        this._groveLoading = k;
        if (this._tab === 'graph') this._renderBody();
        const d = await this._get('/api/paper/graph/grove?kind=' + encodeURIComponent(k));
        const ok = (d && typeof d === 'object');
        // Une réponse valide se garde MÊME si on regarde ailleurs depuis : c'est
        // un cache, et jeter ce qu'on vient de payer ferait re-demander la même
        // chose au premier retour.
        if (ok) {
            const items = Array.isArray(d.items)
                ? d.items.filter((n) => n && typeof n === 'object') : [];
            const total = this._n(d.total);
            this._groveCache[k] = { items: items,
                total: (total === null || total < 0) ? items.length : total };
        }
        // Deux bosquets ouverts coup sur coup : seule la lecture EN COURS rend
        // la main à l'écran, sinon on repeindrait sous le nom d'un autre.
        if (this._groveLoading !== k) return;
        this._groveLoading = '';
        if (!ok) this._toast('error', Lang.t('paper.error'));
        if (this._tab === 'graph') this._renderBody();
    },

    _groveOf(kind) {
        const k = this._groveKindOf(kind);
        return (k && Object.prototype.hasOwnProperty.call(this._groveCache, k))
            ? this._groveCache[k] : null;
    },

    // Descendre (ou remonter) d'un cran. Rien n'est validé ici : c'est
    // _drillPlan qui confronte le chemin demandé aux données réelles — une
    // famille ou un sujet qu'elles ne portent pas ramène simplement au niveau
    // au-dessus, plutôt que d'afficher un niveau vide.
    drillTo(fam, theme, sub) {
        const f = String(fam == null ? '' : fam);
        const t = String(theme == null ? '' : theme);
        const s = String(sub == null ? '' : sub);
        if (f === this._drillFam && t === this._drillTheme && s === this._drillSub) return;
        this._drillFam = f;
        this._drillTheme = t;
        this._drillSub = s;
        this._graphHover = null;
        this._renderBody();
    },

    // La famille de SOURCE d'un item. Un type hors table -> « other » : il
    // existe, il se range, il ne prend le nom d'aucune famille connue.
    _drillFamOf(n) {
        return this._gfam(n && n.type) || 'other';
    },

    // La clé de sujet d'un item. Le serveur n'en pose PAS quand rien ne se
    // groupe (cf. _grove_themed) : l'item rejoint alors le fourre-tout, qui est
    // le seul sujet possible dans ce cas — et un niveau à un seul nœud saute.
    _drillThemeKey(n) {
        const k = (n && typeof n.theme_key === 'string') ? n.theme_key : '';
        return k || this._GTHEME_MISC;
    },

    // Le NOM d'un sujet. Le fourre-tout arrive nommé en français par le serveur
    // (« Divers ») : on le RECONNAÎT par sa clé — whitelist FERMÉE — et on rend
    // le nom de la langue de l'écran. Un sujet nommé, lui, est fait des mots des
    // titres qu'il range : il n'a pas de traduction, et n'en veut pas.
    _drillThemeName(key, n) {
        const k = String(key == null ? '' : key);
        if (k === this._GTHEME_MISC) return Lang.t('paper.theme_misc');
        const l = (n && n.theme_label !== undefined && n.theme_label !== null)
            ? String(n.theme_label) : '';
        return l || k;
    },

    // La clé d'un SOUS-SUJET. Le serveur ne pose « subtheme_label » que sur les
    // gros sujets qu'il a su subdiviser : un item sans étiquette rejoint le
    // fourre-tout, exactement comme un item sans sujet.
    //
    // Ici la clé EST le libellé — le serveur n'envoie pas de clé de sous-sujet,
    // et fabriquer une clé dérivée (minuscules, sans accents) ferait deux
    // identités pour un même groupe le jour où le serveur en changerait la
    // casse. Le fourre-tout garde, lui, la clé du fourre-tout des sujets :
    // c'est la même notion (« ce qui n'a pas de nom »), donc le même mot, donc
    // la même traduction.
    _drillSubKey(n) {
        const l = (n && n.subtheme_label !== undefined && n.subtheme_label !== null)
            ? String(n.subtheme_label).replace(/\s+/g, ' ').trim() : '';
        return l || this._GTHEME_MISC;
    },

    _drillSubName(key) {
        const k = String(key == null ? '' : key);
        return (k === this._GTHEME_MISC) ? Lang.t('paper.theme_misc') : k;
    },

    // Le RANGEMENT commun aux sujets et aux sous-sujets : les gros paquets
    // d'abord (c'est ce qu'on vient chercher), le FOURRE-TOUT toujours en queue
    // (ce n'est pas un sujet, c'est ce qui n'en a pas), la clé tranchant les ex
    // aequo — deux lectures des mêmes données rendent exactement la même page.
    // Une seule copie de cette règle : les deux étages doivent se lire pareil.
    _drillGroups(rows, keyOf, nameOf) {
        const map = {}, order = [];
        rows.forEach((n) => {
            const k = keyOf(n);
            if (!Object.prototype.hasOwnProperty.call(map, k)) {
                map[k] = { key: k, label: nameOf(k, n), rows: [] };
                order.push(k);
            }
            map[k].rows.push(n);
        });
        const misc = this._GTHEME_MISC;
        return order.map((k) => map[k]).sort((a, b) => {
            const ma = (a.key === misc) ? 1 : 0, mb = (b.key === misc) ? 1 : 0;
            if (ma !== mb) return ma - mb;
            if (a.rows.length !== b.rows.length) return b.rows.length - a.rows.length;
            return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
        });
    },

    _drillThemes(rows) {
        return this._drillGroups(rows, (n) => this._drillThemeKey(n),
            (k, n) => this._drillThemeName(k, n));
    },

    // Les sous-sujets d'un sujet. Deux groupes au moins pour que l'étage
    // existe : un sous-sujet unique n'est pas un choix, il est SAUTÉ comme
    // n'importe quel étage à un seul nœud.
    _drillSubs(rows) {
        return this._drillGroups(rows, (n) => this._drillSubKey(n),
            (k) => this._drillSubName(k));
    },

    // Le chemin DEMANDÉ confronté aux données : rend le chemin EFFECTIF et tout
    // ce qu'il faut pour le dessiner. PUR — mêmes données, même plan.
    //
    // Règle « pas de niveau inutile » : un étage qui n'aurait qu'un seul nœud
    // est SAUTÉ (un bosquet radar n'a qu'une famille, un sujet unique n'est pas
    // un choix). Un étage sauté n'existe pas non plus dans le fil d'Ariane : on
    // ne propose pas de revenir là où il n'y a rien à choisir.
    _drillPlan(pivotId) {
        const kind = this._groveKindOf(pivotId);
        const role = this._groveRole(kind);
        const g = kind ? this._groveOf(kind) : null;
        // Un type de STRUCTURE glissé dans la liste (l'agrégat, par exemple) est
        // ignoré : ce n'est pas une information, il n'a pas de famille, et le
        // ranger fabriquerait une famille « Autre » qui ne veut rien dire.
        const items = (g ? g.items : []).filter((n) =>
            !Object.prototype.hasOwnProperty.call(this._GDRILL_SKIP, this._gtype(n.type)));
        const total = g ? g.total : 0;

        const byFam = {};
        items.forEach((n) => {
            const f = this._drillFamOf(n);
            (byFam[f] = byFam[f] || []).push(n);
        });
        // Ordre FIXE de la légende : deux rendus doivent donner la même image.
        const fams = this._GFAM_ORDER.filter((f) => byFam[f] && byFam[f].length);

        const famSkip = (fams.length <= 1);
        let fam = String(this._drillFam || '');
        if (famSkip) fam = fams.length ? fams[0] : '';
        else if (fam && fams.indexOf(fam) < 0) fam = '';
        const famItems = fam ? byFam[fam] : [];

        const themes = fam ? this._drillThemes(famItems) : [];
        const themeSkip = (themes.length <= 1);
        let theme = fam ? String(this._drillTheme || '') : '';
        let ti = -1;
        for (let i = 0; i < themes.length; i++) {
            if (themes[i].key === theme) { ti = i; break; }
        }
        if (themeSkip) { ti = themes.length ? 0 : -1; theme = (ti >= 0) ? themes[0].key : ''; }
        else if (ti < 0) theme = '';

        const themeRows = (ti >= 0) ? themes[ti].rows : [];

        // L'étage des SOUS-SUJETS. Il n'existe que si le serveur a su
        // subdiviser ce sujet (« subtheme_label » sur ses items) et qu'il en
        // sort au moins deux groupes — sinon il est SAUTÉ, comme n'importe
        // quel étage à un seul nœud, et l'on tombe directement sur les dépêches.
        const subs = theme ? this._drillSubs(themeRows) : [];
        const subSkip = (subs.length <= 1);
        let sub = theme ? String(this._drillSub || '') : '';
        let si = -1;
        for (let i = 0; i < subs.length; i++) {
            if (subs[i].key === sub) { si = i; break; }
        }
        if (subSkip) { si = subs.length ? 0 : -1; sub = (si >= 0) ? subs[si].key : ''; }
        else if (si < 0) sub = '';

        const level = sub ? 4 : (theme ? 3 : (fam ? 2 : 1));
        // Où mène le tronc. Null = il n'y a rien au-dessus : l'étage du dessus a
        // été sauté, il n'existe pas. La cascade traverse les étages sautés —
        // un dernier niveau atteint sans passer par les sous-sujets remonte
        // droit aux sujets.
        let up = null;
        if (level === 4 && !subSkip) up = { fam: fam, theme: theme, sub: '' };
        else if (level >= 3 && !themeSkip) up = { fam: fam, theme: '', sub: '' };
        else if (level >= 2 && !famSkip) up = { fam: '', theme: '', sub: '' };

        const leaves = (si >= 0) ? subs[si].rows : [];
        const subLabel = (si >= 0) ? subs[si].label : '';
        const cross = (level === 4)
            ? this._drillCross(items, fam, theme, (subSkip ? '' : sub)) : [];

        return { kind: kind, role: role, items: items, total: total,
            fams: fams, byFam: byFam, fam: fam, famSkip: famSkip,
            famItems: famItems, themes: themes, theme: theme,
            themeSkip: themeSkip, themeLabel: (ti >= 0) ? themes[ti].label : '',
            themeRows: themeRows,
            subs: subs, sub: sub, subSkip: subSkip, subLabel: subLabel,
            // Le nom de CE QU'ON LIT au dernier niveau : le sous-sujet quand
            // l'étage existe, le sujet sinon. Un étage sauté ne nomme rien.
            leafLabel: (sub && !subSkip) ? subLabel : ((ti >= 0) ? themes[ti].label : ''),
            leaves: leaves, cross: cross,
            // Ce que l'aile de convergence NE MONTRE PAS. Les dépêches de la
            // famille ouverte, elles, sont toutes dans la liste dépliée
            // dessous ; celles des autres familles n'y sont pas — un plafond
            // qui se tait leur ferait perdre ce qu'il coupe.
            crossHidden: Math.max(0, cross.length -
                ((cross.length > leaves.length)
                  ? this._GDRILL_LEAVES : this._GDRILL_CROSS)),
            // Qui prend l'ÉVENTAIL principal. Par défaut la famille ouverte —
            // c'est elle qu'on est venu lire. Mais quand les autres sources sont
            // PLUS NOMBREUSES, c'est le gros du sujet qui est ailleurs : les
            // rôles s'inversent, et l'éventail dit toujours « voilà le gros ».
            convSwap: (cross.length > leaves.length),
            level: level, up: up };
    },

    // Les dépêches des AUTRES familles qui parlent du MÊME sujet — l'aile de
    // convergence. PUR, et trié par une clé TOTALE (famille dans l'ordre de la
    // légende, puis fraîcheur, puis identifiant) : deux rendus des mêmes
    // données rendent exactement la même image.
    //
    // Un sujet FOURRE-TOUT ne corrobore rien : « Divers » n'est pas un sujet,
    // c'est ce qui n'en a pas, et faire converger dessus les « Divers » des
    // autres familles fabriquerait une corroboration qui n'existe pas. On rend
    // donc une aile VIDE — la vue reste celle d'avant.
    _drillCross(items, fam, theme, sub) {
        if (!fam || !theme || theme === this._GTHEME_MISC) return [];
        const rows = items.filter((n) => {
            if (this._drillFamOf(n) === fam) return false;
            if (this._drillThemeKey(n) !== theme) return false;
            // Le sous-sujet ne filtre QUE s'il a été choisi : à l'étage des
            // dépêches d'un sujet non subdivisé, tout le sujet corrobore.
            if (sub && this._drillSubKey(n) !== sub) return false;
            return true;
        });
        const order = this._GFAM_ORDER;
        return rows.sort((a, b) => {
            const fa = order.indexOf(this._drillFamOf(a));
            const fb = order.indexOf(this._drillFamOf(b));
            if (fa !== fb) return fa - fb;
            const ta = String(a.ts == null ? '' : a.ts);
            const tb = String(b.ts == null ? '' : b.ts);
            if (ta !== tb) return ta < tb ? 1 : -1;      // la plus fraîche d'abord
            const ia = String(a.id == null ? '' : a.id);
            const ib = String(b.id == null ? '' : b.id);
            return ia < ib ? -1 : (ia > ib ? 1 : 0);
        });
    },

    // Le fil d'Ariane, au-dessus du canvas : « Contexte mondial › Politique ›
    // Tariffs · Canada › Beef ». Chaque segment remonte à SON niveau ; le
    // dernier est là où l'on est, il ne se clique pas. Les étages sautés n'y
    // figurent pas — il n'y a rien à y choisir.
    _drillCrumbs(D) {
        if (!D.kind) return '';
        const segs = [{ label: this._gPivotLabel(D.role), fam: '', theme: '', sub: '' }];
        if (D.fam && !D.famSkip) {
            segs.push({ label: this._gfamLabel(D.fam), fam: D.fam, theme: '', sub: '' });
        }
        if (D.theme && !D.themeSkip) {
            segs.push({ label: D.themeLabel, fam: D.fam, theme: D.theme, sub: '' });
        }
        if (D.sub && !D.subSkip) {
            segs.push({ label: D.subLabel, fam: D.fam, theme: D.theme, sub: D.sub });
        }
        const base = 'font:inherit;font-size:13px;line-height:1.4;padding:0;';
        return '<div style="display:flex;align-items:baseline;gap:6px;' +
               'flex-wrap:wrap;margin:2px 0 10px;">' +
            segs.map((s, i) => {
                const sep = i ? ('<span style="color:var(--text-dim);font-size:12px;">' +
                    esc(this._GCRUMB_SEP) + '</span>') : '';
                if (i === segs.length - 1) {
                    return sep + '<span style="' + base + 'color:var(--text);">' +
                        esc(this._gtrim(s.label, 42)) + '</span>';
                }
                return sep + '<button type="button" data-paper-act="gdrill" ' +
                    'data-fam="' + esc(s.fam) + '" data-theme="' + esc(s.theme) + '" ' +
                    'data-sub="' + esc(s.sub) + '" ' +
                    'style="' + base + 'background:none;border:0;color:var(--text-muted);' +
                    'cursor:pointer;text-decoration:underline;text-underline-offset:3px;">' +
                    esc(this._gtrim(s.label, 42)) + '</button>';
            }).join('') +
        '</div>';
    },

    // Ce que le niveau courant attend du lecteur — en tête de carte, à la place
    // du nom du bosquet, que le fil d'Ariane porte déjà. Table FERMÉE indexée
    // par le NIVEAU : les étages sautés font sauter des numéros (un sujet non
    // subdivisé passe de 2 à 4), un tableau indexé par position mentirait.
    _DRILL_HINT: { 1: 'paper.gdrill_hint_fam', 2: 'paper.gdrill_hint_theme',
        3: 'paper.gdrill_hint_sub', 4: 'paper.gdrill_hint_leaf' },

    _drillHint(D) {
        const k = String(D.level);
        return Lang.t(Object.prototype.hasOwnProperty.call(this._DRILL_HINT, k)
            ? this._DRILL_HINT[k] : this._DRILL_HINT['1']);
    },

    // Le dernier niveau : la liste COMPLÈTE de ce qu'on a ouvert, sous la toile
    // — le sous-sujet quand il y en a un, le sujet sinon. Le canvas en dessine
    // les plus récentes, celle-ci les porte toutes : c'est ce partage qui
    // remplace l'anneau « +N autres ».
    _drillList(D) {
        if (D.level !== 4 || !D.leaves.length) return '';
        const shown = D.items.length;
        return '<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">' +
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px;">' +
              '<h4 style="margin:0;font-size:15px;">' +
                esc(Lang.t('paper.gdrill_all') + ' ' + this._gtrim(D.leafLabel, 42)) + '</h4>' +
              '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                esc(this._num(D.leaves.length, 0) + ' ' + Lang.t('paper.graph_items')) + '</span>' +
            '</div>' +
            '<div class="row-list" style="max-height:380px;overflow-y:auto;">' +
              D.leaves.map((n) => this._groveRow(n, D.kind)).join('') +
            '</div>' +
            // Le plafond de liste du SERVEUR dit ce qu'il laisse dehors : une
            // liste qui s'arrête en silence ment par omission.
            ((D.total > shown)
              ? '<div style="font-size:12px;color:var(--text-dim);margin-top:8px;">' +
                  esc(Lang.t('paper.grove_capped')) + '</div>'
              : '') +
        '</div>';
    },

    // =====================================================================
    //  La liste PLATE d'un bosquet — ouverte par l'agrégat d'un arbre de titre
    // =====================================================================
    //
    // Ce chemin-là subsiste : rapproché sur un TITRE, la toile porte encore les
    // agrégats des bosquets qui le touchent, et leur clic doit toujours ouvrir
    // ce qu'ils comptent. Les bosquets, eux, n'en ont plus (ils se lisent par
    // niveaux) — d'où deux panneaux et non un seul.

    async openGrove(kind) {
        const k = this._groveKindOf(kind);
        if (!k) return;
        // Re-cliquer le même agrégat REFERME la liste : c'est le seul geste
        // disponible sur le canvas, il doit faire l'aller ET le retour.
        if (this._groveOpen === k) { this.closeGrove(); return; }
        this._groveOpen = k;
        if (this._tab === 'graph') this._renderBody();
        await this._groveFetch(k, false);
        if (this._groveOpen === k && this._tab === 'graph') this._renderBody();
    },

    _groveItems() {
        const g = this._groveOf(this._groveOpen);
        return g ? g.items : [];
    },

    // Le panneau, SOUS la toile — pas une modale : on garde le dessin à l'œil
    // pendant qu'on lit la liste, et c'est ce qui fait comprendre d'où elle
    // sort. Vide quand aucun bosquet n'est ouvert.
    _groveCard() {
        const kind = this._groveOpen;
        if (!kind) return '';
        const role = this._groveRole(kind);
        const g = this._groveOf(kind);
        const items = this._groveItems();
        const total = g ? this._n(g.total) : null;
        const shown = items.length;
        let body;
        if (this._groveLoading === kind) {
            body = this._muted(Lang.t('paper.grove_loading'));
        } else if (!shown) {
            body = this._muted(Lang.t('paper.grove_empty'));
        } else {
            body = '<div class="row-list" style="max-height:380px;overflow-y:auto;">' +
                this._groveSections(items).map((sec) =>
                    this._groveHead(sec) +
                    sec.rows.map((n) => this._groveRow(n, kind)).join('')).join('') +
                '</div>' +
                // Le plafond de liste DIT ce qu'il laisse dehors, comme
                // l'agrégat de la toile : une liste qui s'arrête en silence
                // ment par omission.
                ((total !== null && total > shown)
                  ? '<div style="font-size:12px;color:var(--text-dim);margin-top:8px;">' +
                      esc(Lang.t('paper.grove_capped')) + '</div>'
                  : '');
        }
        const count = (total === null) ? shown : total;
        return '<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">' +
            '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px;">' +
              '<h4 style="margin:0;font-size:15px;">' +
                esc(Lang.t('paper.grove_all') + ' ' + this._gPivotLabel(role)) + '</h4>' +
              '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                esc(this._num(count, 0) + ' ' + Lang.t('paper.graph_items')) + '</span>' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="grove-close" ' +
                  'style="margin-left:auto;">' + esc(Lang.t('paper.close')) + '</button>' +
            '</div>' + body +
        '</div>';
    },

    // La liste, coupée en SUJETS. Le serveur envoie chaque item avec son thème
    // et les a DÉJÀ rangés ; on ne fait que découper les tranches CONSÉCUTIVES,
    // sans jamais re-trier — deux lectures de la même liste donnent la même
    // page, et l'ordre reste celui de la toile.
    //
    // Aucun champ de thème (bosquet où rien ne se groupe) : une seule tranche
    // sans intertitre, donc la liste à plat d'avant, à l'octet près.
    _groveSections(items) {
        const out = [];
        let cur = null;
        items.forEach((n) => {
            const key = (typeof n.theme_key === 'string') ? n.theme_key : '';
            if (cur === null || cur.key !== key) {
                cur = { key: key, label: this._groveThemeLabel(n), rows: [] };
                out.push(cur);
            }
            cur.rows.push(n);
        });
        return out;
    },

    // Le nom d'un sujet dans la liste. Le fourre-tout arrive nommé en français
    // par le serveur : on le RECONNAÎT par sa clé (whitelist FERMÉE) et on rend
    // le nom de la langue de l'écran — jamais le mot du serveur.
    _groveThemeLabel(n) {
        const key = (typeof n.theme_key === 'string') ? n.theme_key : '';
        if (!key) return '';
        if (key === this._GTHEME_MISC) return Lang.t('paper.theme_misc');
        return String(n.theme_label === undefined || n.theme_label === null
            ? '' : n.theme_label);
    },

    // L'intertitre : le sujet, et le nombre de lignes qu'il porte. Muted et
    // mono — il structure la lecture, il ne se dispute pas la place avec les
    // titres.
    _groveHead(sec) {
        if (!sec.label) return '';
        return '<div style="display:flex;gap:8px;align-items:baseline;' +
               'padding:12px 12px 4px;font-size:12px;color:var(--text-dim);' +
               this._mono + 'text-transform:uppercase;letter-spacing:.06em;">' +
            '<span>' + esc(this._gtrim(sec.label, 42)) + '</span>' +
            '<span style="opacity:.7;">' + esc(this._num(sec.rows.length, 0)) + '</span>' +
        '</div>';
    },

    // Une ligne : quand · d'où · quoi · où l'ouvrir. Le titre complet vit dans
    // l'attribut « title » — on tronque à l'écran, jamais dans la donnée.
    _groveRow(n, kind) {
        const t = this._gtype(n.type);
        const fam = this._gfam(t);
        const label = String(n.label === undefined || n.label === null ? '' : n.label);
        const when = (n.ts === undefined || n.ts === null || n.ts === '')
            ? '' : this._dateShort(n.ts);
        const url = this._safeUrl(n.link);
        const out = this._gOutcome(n.outcome);
        const tickers = (n.meta && Array.isArray(n.meta.tickers))
            ? n.meta.tickers.slice(0, 4).map((s) => String(s)).join(' ') : '';
        return '<div class="row" style="display:flex;gap:10px;align-items:center;' +
               'flex-wrap:wrap;padding:9px 12px;">' +
            ((when && when !== '—')
              ? '<span style="font-size:12px;color:var(--text-dim);' + this._mono +
                'flex:0 0 auto;">' + esc(when) + '</span>' : '') +
            // La pastille de FAMILLE : d'où vient l'item, dans le même
            // alphabet de couleurs que la toile (composant de la légende).
            (fam
              ? '<span class="paper-graph-key" style="flex:0 0 auto;">' +
                  '<i style="background:' + esc(this._gfamColor(fam)) + ';"></i>' +
                  esc(this._gfamLabel(fam)) + '</span>'
              : '') +
            this._groveSentBadge(n) +
            // Le VERDICT, en toutes lettres : c'est ce qu'on vient chercher
            // dans le bosquet du radar.
            ((kind === 'radar' && out)
              ? '<span class="badge ' + esc(this._GROVE_OUT_BADGE[out]) + '">' +
                  esc(Lang.t(this._GHYP_OUT[out][1])) + '</span>' : '') +
            '<span style="flex:1 1 260px;min-width:0;font-size:14px;line-height:1.45;" ' +
                'title="' + esc(label) + '">' +
              esc(this._gtrim(label, this._GROVE_TITLE_MAX)) + '</span>' +
            (tickers
              ? '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(tickers) + '</span>' : '') +
            (url
              ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
                'class="btn btn-ghost btn-sm" style="text-decoration:none;">' +
                esc(Lang.t('paper.open')) + '</a>'
              : '') +
        '</div>';
    },

    // La tonalité, quand elle en porte une ET qu'elle dit quelque chose.
    //
    // Whitelist FERMÉE, et pas le _sentiment() du fil de presse : celui-ci
    // retombe sur « positif » pour TOUT ce qu'il ne connaît pas, or un bosquet
    // charrie aussi des tonalités que le fil ne voit jamais (« crowd » d'un
    // post Reddit, « neutral » d'une dépêche non qualifiée). Un post Reddit
    // affiché « positif » serait un jugement inventé.
    _GROVE_SENT: {
        pos: ['online', 'paper.news_pos'],
        neg: ['danger', 'paper.news_neg'],
        watch: ['warn', 'paper.news_watch'],
        gov: ['warn', 'paper.news_gov'],
    },

    _groveSentBadge(n) {
        const s = this._gtype(n && n.sentiment);
        if (!Object.prototype.hasOwnProperty.call(this._GROVE_SENT, s)) return '';
        return '<span class="badge ' + esc(this._GROVE_SENT[s][0]) + '">' +
            esc(Lang.t(this._GROVE_SENT[s][1])) + '</span>';
    },

    // Chip d'un graphique : on OUVRE la vue Connexions déjà rapprochée sur ce
    // titre. L'onglet bascule tout de suite (l'écran répond), la toile arrive
    // derrière — jamais l'inverse.
    openGraph(symbol) {
        const sym = String(symbol || '');
        if (!sym) return;
        if (this._tab === 'trade') { this._captureForm(); this._saveDraft(); }
        this._tab = 'graph';
        this._saveUi();
        this._renderTabs();
        this.loadGraph(sym);
    },

    _graphChip(symbol) {
        const sym = String(symbol || '');
        const n = this._graphCounts[sym];
        if (!n) return '';
        return '<button class="btn btn-ghost btn-sm paper-graph-chip" ' +
                'data-paper-act="graph-open" data-sym="' + esc(sym) + '" ' +
                'title="' + esc(Lang.t('paper.graph_chip_hint')) + '">' +
            esc(this._num(n, 0) + ' ' + Lang.t('paper.graph_chip')) + '</button>';
    },

    // =====================================================================
    //  GRAPHIQUE EN BOUGIES — canvas 2D pur, AUCUNE librairie, AUCUN CDN
    // =====================================================================
    //
    // Un seul composant monte a trois endroits (Nouveau trade / Portefeuille /
    // Analyse). Le dessin relit les tokens CSS a CHAQUE trace : dark et clair
    // « Givre » sortent justes tous les deux, et un changement d'accent se
    // rethemera au prochain trace (meme semantique que Chart.js dans ce projet).

    // [periode API, intervalle API, cle du libelle]
    _CHART_RANGES: [
        ['5d', '15m', 'paper.chart_5d'],
        ['1mo', '1d', 'paper.chart_1mo'],
        ['6mo', '1d', 'paper.chart_6mo'],
        ['1y', '1d', 'paper.chart_1y'],
        ['5y', '1wk', 'paper.chart_5y'],
    ],

    _tok(name) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name);
            return String(v || '').trim();
        } catch (e) { return ''; }
    },

    _rangeOf(ctxKey) { return this._chartRange[ctxKey] || '6mo'; },

    _intervalOf(range) {
        for (let i = 0; i < this._CHART_RANGES.length; i++) {
            if (this._CHART_RANGES[i][0] === range) return this._CHART_RANGES[i][1];
        }
        return '1d';
    },

    _candleKey(symbol, range) { return String(symbol) + '|' + String(range); },

    setChartRange(ctxKey, range) {
        if (!ctxKey || !range || !this._isChartRange(range)) return;
        if (this._tab === 'trade') this._captureForm();
        this._chartRange[ctxKey] = String(range);
        if (ctxKey === 'trade') this._saveUi();
        this._renderBody();
    },

    // Rendu SYNCHRONE depuis le cache. Ce qui manque est empile dans
    // _chartWanted et sera demande par _mountCharts, apres l'ecriture du DOM.
    _chartCard(ctxKey, symbol, currency) {
        if (!symbol) return '';
        const range = this._rangeOf(ctxKey);
        const interval = this._intervalOf(range);
        const key = this._candleKey(symbol, range);
        const st = this._candles[key];
        if (!st) {
            this._chartWanted.push({ symbol: symbol, range: range, interval: interval });
        }
        const pills = this._CHART_RANGES.map((r) =>
            '<button class="paper-tab' + (r[0] === range ? ' active' : '') + '" ' +
                'data-paper-act="chart-range" data-ctx="' + esc(ctxKey) + '" ' +
                'data-range="' + esc(r[0]) + '">' + esc(Lang.t(r[2])) + '</button>'
        ).join('') +
            // La raison des rechargements de page : « voir si la courbe a
            // bougé ». Ce bouton fait exactement ça, sans rien perdre.
            '<button class="paper-tab" data-paper-act="chart-reload" ' +
                'data-sym="' + esc(symbol) + '" title="' + esc(Lang.t('paper.chart_reload')) + '">' +
              esc(Lang.t('paper.chart_reload')) + '</button>';

        let body;
        if (!st || st.loading) {
            body = this._muted(Lang.t('paper.chart_loading'));
        } else if (st.error) {
            body = '<div style="color:var(--danger);font-size:14px;line-height:1.55;">' +
                esc(Lang.t('paper.chart_error')) + '</div>';
        } else if (!st.data || !Array.isArray(st.data.candles) || !st.data.candles.length) {
            body = this._muted(Lang.t('paper.chart_empty'));
        } else {
            body = '<canvas data-paper-chart="' + esc(ctxKey) + '" ' +
                        'data-sym="' + esc(symbol) + '" data-range="' + esc(range) + '" ' +
                        'style="width:100%;height:300px;display:block;touch-action:pan-y;"></canvas>' +
                   this._chartLegend(symbol);
        }
        const cur = (st && st.data && st.data.currency) || currency || '';
        // La memoire du coach ne s'affiche QUE la ou on decide (Nouveau trade)
        // ou l'on ouvre une position — pas sous la fiche d'analyse, qui est
        // deja un texte du coach.
        const decides = (ctxKey === 'trade' || String(ctxKey).indexOf('pos:') === 0);
        const memory = decides ? this._symIdeasHtml(symbol) : '';
        // Meme endroit, meme regle : le chip n'existe que si la toile a
        // VRAIMENT quelque chose sur ce titre (compteur a 0 => rien du tout).
        const chip = decides ? this._graphChip(symbol) : '';
        return this._card(
            // position:relative : la carte flottante s'ancre a CE bloc, jamais
            // au formulaire d'ordre qui vit dessous. Et quand elle est la, la
            // ligne de titre RESERVE sa largeur (.with-memory) : sans ca, la
            // carte recouvrait les pastilles de periode et le bouton Actualiser
            // — vu a l'ecran, ils devenaient inclicables.
            memory +
            '<div class="paper-chart-head' + (memory ? ' with-memory' : '') + '" ' +
                 'style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
              '<span style="font-size:16px;font-weight:600;">' + esc(symbol) + '</span>' +
              (cur ? '<span style="font-size:12px;color:var(--text-dim);' + this._mono + '">' +
                  esc(cur) + '</span>' : '') +
              chip +
              '<div class="paper-tabs" style="margin:0 0 0 auto;">' + pills + '</div>' +
            '</div>' + body,
            'position:relative;'
        );
    },

    // --- Ce que le coach a DEJA dit de ce titre (zero LLM) -------------------
    //
    // Lecture de memoire pure : radar, journal d'idees, revues de positions.
    // Regle dure : si le coach n'a jamais parle de ce titre, il n'y a AUCUN
    // element a l'ecran — pas d'encart vide, pas d'appel, pas de depense.

    async _loadSymIdeas(symbol) {
        const sym = String(symbol || '');
        if (!sym) return;
        // Re-selectionner un titre rouvre sa carte : une fermeture vaut pour
        // la consultation en cours, pas pour toujours.
        delete this._symIdeasClosed[sym];
        const d = await this._get('/api/paper/ideas/for-symbol?symbol=' + encodeURIComponent(sym));
        const items = (d && Array.isArray(d.items)) ? d.items : [];
        this._symIdeas[sym] = { items: items };
        if (!items.length) return;              // rien a dire : on ne dessine rien
        this._renderBody();
    },

    closeSymIdeas(symbol) {
        const sym = String(symbol || '');
        if (!sym) return;
        this._symIdeasClosed[sym] = true;
        this._renderBody();
    },

    toggleSymText(key) {
        const k = String(key || '');
        if (!k) return;
        if (this._symTextOpen[k]) delete this._symTextOpen[k];
        else this._symTextOpen[k] = true;
        this._renderBody();
    },

    _symFromBadge(from) {
        const f = String(from == null ? '' : from).toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(this._SYM_FROM, f)) return '';
        return '<span class="badge">' + esc(Lang.t(this._SYM_FROM[f])) + '</span>';
    },

    _symIdeaItem(sym, it, i) {
        if (!it || typeof it !== 'object') return '';
        const key = String(sym) + '|' + String(i);
        const open = !!this._symTextOpen[key];
        // Une these (idee) ou une raison (revue) : le meme texte pour le lecteur.
        const txt = String(this._pickField(it, ['thesis', 'reason']) || '');
        const short = (txt.length > 90) ? (txt.slice(0, 90) + '…') : txt;
        const horizon = this._n(it.horizon_days);
        const scored = (String(it.status || '') === 'scored');
        return '<div style="padding:8px 0;border-top:1px solid var(--border);">' +
            '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
              '<span style="' + this._mono + 'font-size:11px;color:var(--text-dim);">' +
                esc(this._dateShort(it.ts)) + '</span>' +
              this._symFromBadge(it.from) +
              (it.direction
                ? '<span class="badge ' + this._direction(it.direction) + '">' +
                  esc(String(it.direction)) + '</span>' : '') +
              (it.stance ? this._stanceBadge(it.stance) : '') +
              (scored ? this._outcomeBadge(it.outcome) : '') +
            '</div>' +
            (horizon === null ? '' :
              '<div style="' + this._mono + 'font-size:11px;color:var(--text-dim);margin-top:3px;">' +
                esc(Lang.t('paper.radar_horizon') + ' ' + this._num(horizon, 0) + ' ' +
                    Lang.t('paper.radar_days')) + '</div>') +
            (txt
              ? '<div style="font-size:13px;line-height:1.5;margin-top:4px;">' +
                  esc(open ? txt : short) +
                  ((txt.length > 90)
                    ? ' <button class="btn btn-ghost btn-sm" data-paper-act="sym-text" ' +
                          'data-key="' + esc(key) + '" style="padding:0 5px;">' +
                        esc(Lang.t(open ? 'paper.hide_text' : 'paper.show_text')) + '</button>'
                    : '') +
                '</div>'
              : '') +
        '</div>';
    },

    _symIdeasHtml(symbol) {
        const sym = String(symbol || '');
        if (!sym || this._symIdeasClosed[sym]) return '';
        const d = this._symIdeas[sym];
        const items = (d && Array.isArray(d.items)) ? d.items : [];
        // LA regle : rien a dire => rien du tout dans le DOM.
        if (!items.length) return '';
        const head = Lang.t('paper.symideas_title') + ' ' + sym;
        return '<div class="paper-symideas">' +
            '<div style="display:flex;gap:8px;align-items:baseline;">' +
              '<span style="flex:1 1 auto;min-width:0;font-size:12px;letter-spacing:.06em;' +
                   'text-transform:uppercase;color:var(--text-dim);">' + esc(head) + '</span>' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="sym-close" ' +
                  'data-sym="' + esc(sym) + '" style="padding:0 6px;line-height:1.2;" ' +
                  'title="' + esc(Lang.t('paper.close')) + '">' +
                esc(Lang.t('paper.close_mark')) + '</button>' +
            '</div>' +
            items.slice(0, 2).map((it, i) => this._symIdeaItem(sym, it, i)).join('') +
            '<div style="margin-top:6px;">' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="sym-all">' +
                esc(Lang.t('paper.symideas_all')) + '</button>' +
            '</div>' +
        '</div>';
    },

    // Actualiser le graphique : on jette les bougies EN CACHE de ce titre
    // (toutes periodes) et on relit le cours. C'est ce que le rechargement de
    // page faisait — en moins destructeur.
    async reloadChart(symbol) {
        const sym = String(symbol || '');
        if (!sym) return;
        const pref = sym + '|';
        Object.keys(this._candles).forEach((k) => {
            if (k.indexOf(pref) === 0) delete this._candles[k];
        });
        if (this._tab === 'trade') this._captureForm();
        this._renderBody();                     // « chargement… » + demande empilee
        if (this._pick && String(this._pick.symbol) === sym) {
            const d = await this._get('/api/paper/quotes?symbols=' + encodeURIComponent(sym));
            const q = (d && typeof d === 'object')
                ? (d[sym] || d[sym.toUpperCase()] || null) : null;
            if (q && typeof q === 'object') this._quote = q;
            if (this._tab === 'trade') { this._captureForm(); this._renderBody(); }
        }
    },

    // Le graphique d'une position ouverte : memes bougies, plus ses reperes.
    _positionChart(symbol) {
        if (!symbol) return '';
        const pos = this._positionOf(symbol);
        const cur = pos ? (pos.currency || '') : '';
        return this._chartCard('pos:' + symbol, symbol, cur);
    },

    _positionOf(symbol) {
        if (!this._p || !symbol) return null;
        const rows = this._p.positions || [];
        for (let i = 0; i < rows.length; i++) {
            if (String(rows[i] && rows[i].symbol) === String(symbol)) return rows[i];
        }
        return null;
    },

    _chartLegend(symbol) {
        const ov = this._overlayFor(symbol);
        const bits = [];
        if (ov.trades.length) bits.push(Lang.t('paper.chart_legend_trades'));
        if (ov.avg !== null) bits.push(Lang.t('paper.chart_legend_avg'));
        if (ov.stop !== null) bits.push(Lang.t('paper.chart_legend_stop'));
        if (!bits.length) return '';
        return '<div style="font-size:11px;color:var(--text-dim);margin-top:6px;">' +
            esc(bits.join(' · ')) + '</div>';
    },

    // Ce que le portefeuille sait de CE symbole : trades clos, prix de revient,
    // stop de protection. Aucune invention : un champ absent reste null.
    _overlayFor(symbol) {
        const out = { trades: [], avg: null, stop: null, entry: null };
        if (!this._p || !symbol) return out;
        const sym = String(symbol);
        (this._p.trades || []).forEach((t) => {
            if (t && String(t.symbol) === sym) out.trades.push(t);
        });
        const pos = this._positionOf(sym);
        if (pos) {
            out.avg = this._n(this._pickField(pos, ['avg_price', 'entry_price']));
            out.stop = this._n(this._pickField(pos, ['stop_loss', 'stop', 'planned_stop']));
            out.entry = { at: this._pickField(pos, ['opened_at', 'entry_at']), price: out.avg };
        }
        return out;
    },

    // ------------------------------------------------------- chargement

    async _loadCandles(symbol, range, interval) {
        const key = this._candleKey(symbol, range);
        if (this._candles[key]) return;
        this._candles[key] = { loading: true, error: false, data: null };
        let r = null;
        try {
            r = await Auth.apiCall('/api/paper/candles?symbol=' + encodeURIComponent(symbol) +
                '&range_=' + encodeURIComponent(range) + '&interval=' + encodeURIComponent(interval));
        } catch (e) { r = null; }
        if (!r || !r.ok) {
            this._candles[key] = { loading: false, error: true, data: null };
        } else {
            let d = null;
            try { d = await r.json(); } catch (e) { d = null; }
            this._candles[key] = { loading: false, error: !d, data: d };
        }
        this._renderBody();
    },

    // ------------------------------------------------------- montage / demontage

    _mountCharts() {
        const wanted = this._chartWanted || [];
        this._chartWanted = [];
        wanted.forEach((w) => { this._loadCandles(w.symbol, w.range, w.interval); });

        const host = document.getElementById('paper-body');
        if (!host) return;
        const nodes = host.querySelectorAll('canvas[data-paper-chart]');
        if (!nodes.length) return;
        const list = [];
        Array.prototype.forEach.call(nodes, (cv) => { this._bindChart(cv); list.push(cv); });
        this._chartBound = list;
        // UN seul ecouteur window pour tous les graphiques de la vue.
        this._onChartResize = () => {
            if (this._resizeTimer) clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => {
                this._resizeTimer = null;
                (this._chartBound || []).forEach((cv) => this._paintChart(cv));
            }, 120);
        };
        window.addEventListener('resize', this._onChartResize);
        list.forEach((cv) => this._paintChart(cv));
    },

    _disposeCharts() {
        (this._chartBound || []).forEach((cv) => {
            if (!cv || !cv._paperOff) return;
            cv._paperOff();
            cv._paperOff = null;
        });
        this._chartBound = [];
        if (this._onChartResize) {
            window.removeEventListener('resize', this._onChartResize);
            this._onChartResize = null;
        }
        if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = null; }
    },

    // Pointeur : la souris survole (crosshair suivi), le doigt TAPE (lecture
    // ponctuelle, pas de crosshair colle sous le doigt).
    _bindChart(cv) {
        if (!cv || cv._paperOff) return;
        const pick = (ev) => {
            const rect = cv.getBoundingClientRect();
            cv._paperHover = ev.clientX - rect.left;
            this._paintChart(cv);
        };
        const onMove = (ev) => { if (ev.pointerType !== 'touch') pick(ev); };
        const onDown = (ev) => pick(ev);
        const onLeave = (ev) => {
            if (ev.pointerType === 'touch') return;   // le tap doit rester lisible
            cv._paperHover = null;
            this._paintChart(cv);
        };
        cv.addEventListener('pointermove', onMove);
        cv.addEventListener('pointerdown', onDown);
        cv.addEventListener('pointerleave', onLeave);
        cv._paperOff = () => {
            cv.removeEventListener('pointermove', onMove);
            cv.removeEventListener('pointerdown', onDown);
            cv.removeEventListener('pointerleave', onLeave);
        };
    },

    _paintChart(cv) {
        if (!cv || !cv.isConnected) return;
        const st = this._candles[this._candleKey(cv.getAttribute('data-sym'),
                                                 cv.getAttribute('data-range'))];
        if (!st || !st.data) return;
        this._drawCandles(cv, st.data, {
            interval: this._intervalOf(cv.getAttribute('data-range')),
            overlay: this._overlayFor(cv.getAttribute('data-sym')),
            hoverX: cv._paperHover,
        });
    },

    // ------------------------------------------------------- graduations

    // Graduations « rondes » : 1, 2, 5 x 10^n. Renvoie aussi le nombre de
    // decimales a afficher, pour ne pas ecrire 81.10000000000001.
    _niceTicks(min, max, count) {
        const span = max - min;
        if (!(span > 0) || !isFinite(span)) return { ticks: [min], dec: 2 };
        const raw = span / Math.max(1, count);
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const norm = raw / mag;
        let step = 10;
        if (norm <= 1) step = 1;
        else if (norm <= 2) step = 2;
        else if (norm <= 5) step = 5;
        step *= mag;
        const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
        const ticks = [];
        const start = Math.ceil(min / step) * step;
        for (let v = start; v <= max + step * 1e-6 && ticks.length < 12; v += step) ticks.push(v);
        return { ticks: ticks, dec: dec };
    },

    _axisLabel(ts, interval) {
        const d = this._toDate(ts);
        if (!d) return '';
        const p = (x) => (x < 10 ? '0' : '') + x;
        if (interval === '15m' || interval === '1h') return p(d.getHours()) + ':' + p(d.getMinutes());
        if (interval === '1wk') return p(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2);
        return p(d.getDate()) + '/' + p(d.getMonth() + 1);
    },

    // ------------------------------------------------------- le trace

    _drawCandles(canvas, data, opts) {
        if (!canvas) return;
        const ctx = canvas.getContext ? canvas.getContext('2d') : null;
        if (!ctx) return;
        const o = opts || {};
        const rows = (data && Array.isArray(data.candles)) ? data.candles : [];

        // Retina : sans le facteur de densite, tout est flou.
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth || 600;
        const cssH = canvas.clientHeight || 300;
        const pw = Math.max(1, Math.round(cssW * dpr));
        const ph = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        if (!rows.length) return;

        // Tokens relus MAINTENANT : les deux modes sortent justes.
        const mono = this._tok('--font-mono') || 'ui-monospace, monospace';
        const C = {
            up: this._tok('--accent') || '#00FFB0',
            down: this._tok('--danger') || '#F87171',
            grid: this._tok('--border') || '#1C2947',
            dim: this._tok('--text-dim') || '#5A6C90',
            muted: this._tok('--text-muted') || '#8FA3C4',
            fg: this._tok('--text') || '#EDF2FA',
            panel: this._tok('--bg-elev-3') || '#131C33',
            strong: this._tok('--border-strong') || '#2C4066',
        };

        const padT = 10, padB = 22, padR = 62, padL = 6;
        const plotX = padL;
        const plotW = Math.max(20, cssW - padL - padR);
        const totalH = Math.max(40, cssH - padT - padB);
        const volH = Math.max(10, Math.round(totalH * 0.15));
        const priceH = Math.max(20, totalH - volH - 8);
        const priceY = padT;
        const volY = padT + priceH + 8;

        // Echelle de prix : bougies + reperes du portefeuille (un stop hors
        // echelle serait dessine hors cadre, donc invisible et trompeur).
        let lo = Infinity, hi = -Infinity;
        rows.forEach((c) => {
            const h = this._n(c && c.high), l = this._n(c && c.low);
            const op = this._n(c && c.open), cl = this._n(c && c.close);
            [h, l, op, cl].forEach((v) => {
                if (v === null) return;
                if (v > hi) hi = v;
                if (v < lo) lo = v;
            });
        });
        if (!isFinite(lo) || !isFinite(hi)) return;
        // Les BOUGIES commandent l'echelle. Un repere du portefeuille (stop, PRU)
        // ne l'elargit que s'il reste proche — sinon un stop 10 % plus bas ecrase
        // toutes les bougies dans le haut du cadre (vu a l'ecran sur la vue 1 mois).
        // Un repere qu'on ne peut pas tracer n'est pas passe sous silence : il est
        // ECRIT sous le graphique.
        const ov = o.overlay || { trades: [], avg: null, stop: null };
        const candleSpan = Math.max(hi - lo, Math.abs(hi) * 1e-4, 1e-9);
        const offscale = [];
        const fit = (v, label) => {
            if (v === null || v === undefined) return;
            const nlo = Math.min(lo, v), nhi = Math.max(hi, v);
            if ((nhi - nlo) / candleSpan <= 1.3) { lo = nlo; hi = nhi; return; }
            offscale.push(label + ' ' + this._num(v, 2));
        };
        fit(ov.stop, Lang.t('paper.chart_stop'));
        fit(ov.avg, Lang.t('paper.chart_avg'));
        if (hi - lo < 1e-9) { const m = Math.abs(hi) * 0.01 || 1; lo -= m; hi += m; }
        const margin = (hi - lo) * 0.06;
        lo -= margin; hi += margin;

        const n = rows.length;
        const step = (n > 1) ? (plotW / n) : plotW;
        const yOf = (p) => priceY + priceH - ((p - lo) / (hi - lo)) * priceH;
        const xOf = (i) => plotX + ((n > 1) ? (i + 0.5) * step : plotW / 2);
        let bodyW = Math.max(2, Math.floor(step - (step > 6 ? 2 : 1)));
        if (n === 1) bodyW = Math.min(28, Math.max(6, Math.floor(plotW * 0.3)));

        // --- grille + axe des prix (a droite) ---
        const tk = this._niceTicks(lo, hi, 5);
        // L'axe s'arrondit (75 / 80 / 85), mais un PRIX lu garde ses centimes :
        // « O 82 » au lieu de « O 82.15 » perd l'information qu'on est venu chercher.
        const priceDec = Math.max(2, tk.dec);
        ctx.font = '10px ' + mono;
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 1;
        tk.ticks.forEach((t) => {
            const y = Math.round(yOf(t)) + 0.5;
            ctx.strokeStyle = C.grid;
            ctx.beginPath();
            ctx.moveTo(plotX, y);
            ctx.lineTo(plotX + plotW, y);
            ctx.stroke();
            ctx.fillStyle = C.dim;
            ctx.textAlign = 'left';
            ctx.fillText(this._num(t, tk.dec), plotX + plotW + 6, y);
        });

        // --- bougies + volume ---
        let vmax = 0;
        rows.forEach((c) => { const v = this._n(c && c.volume); if (v !== null && v > vmax) vmax = v; });
        rows.forEach((c, i) => {
            const op = this._n(c && c.open), cl = this._n(c && c.close);
            const h = this._n(c && c.high), l = this._n(c && c.low);
            if (op === null || cl === null) return;
            const col = (cl >= op) ? C.up : C.down;
            const x = xOf(i);
            const xc = Math.round(x) + 0.5;
            if (h !== null && l !== null) {
                ctx.strokeStyle = col;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(xc, yOf(h));
                ctx.lineTo(xc, yOf(l));
                ctx.stroke();
            }
            const yo = yOf(op), yc = yOf(cl);
            const top = Math.min(yo, yc);
            const hgt = Math.max(1, Math.abs(yc - yo));
            ctx.fillStyle = col;
            ctx.fillRect(Math.round(x - bodyW / 2), Math.round(top), bodyW, Math.max(1, Math.round(hgt)));
            if (vmax > 0) {
                const v = this._n(c && c.volume) || 0;
                const vh = (v / vmax) * volH;
                ctx.globalAlpha = 0.25;           // 25 % : le volume accompagne, il ne crie pas
                ctx.fillRect(Math.round(x - bodyW / 2), volY + volH - vh, bodyW, Math.max(0, vh));
                ctx.globalAlpha = 1;
            }
        });

        // --- axe des dates, clairseme ---
        // Le premier et le dernier libelle sont CALES sur le bord : centres, ils
        // debordent du canvas et se font couper (vu a l'ecran : « 4/02 » au lieu
        // de « 04/02 »).
        ctx.fillStyle = C.dim;
        ctx.textBaseline = 'top';
        const dateY = padT + totalH + 5;
        const want = Math.max(2, Math.min(7, Math.floor(plotW / 90)));
        const putDate = (i, align) => {
            ctx.textAlign = align;
            const x = (align === 'left') ? plotX
                : ((align === 'right') ? plotX + plotW : xOf(i));
            ctx.fillText(this._axisLabel(rows[i] && rows[i].ts, o.interval), x, dateY);
        };
        if (n === 1) {
            putDate(0, 'center');
        } else {
            for (let k = 0; k < want; k++) {
                const i = Math.round(k * (n - 1) / (want - 1));
                putDate(i, k === 0 ? 'left' : (k === want - 1 ? 'right' : 'center'));
            }
        }

        // Un repere trop loin pour tenir dans l'echelle est ANNONCE, pas oublie.
        if (offscale.length) {
            ctx.font = '10px ' + mono;
            ctx.fillStyle = C.dim;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            // Au-dessus de la bande de volume : zone morte, et la ligne des
            // dates reste lisible.
            ctx.fillText(Lang.t('paper.chart_offscale') + ' ' + offscale.join(' · '),
                plotX, volY + 1);
        }

        // --- reperes du portefeuille ---
        const level = (price, label, color) => {
            if (price === null || price === undefined) return;
            const y = Math.round(yOf(price)) + 0.5;
            if (y < priceY - 2 || y > priceY + priceH + 2) return;
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(plotX, y);
            ctx.lineTo(plotX + plotW, y);
            ctx.stroke();
            ctx.restore();
            ctx.font = '10px ' + mono;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = color;
            ctx.fillText(label + ' ' + this._num(price, priceDec), plotX + 4, y - 2);
        };
        level(ov.stop, Lang.t('paper.chart_stop'), C.down);
        level(ov.avg, Lang.t('paper.chart_avg'), C.muted);

        // --- pastilles BUY / SELL ---
        const firstTs = this._toDate(rows[0] && rows[0].ts);
        const lastTs = this._toDate(rows[n - 1] && rows[n - 1].ts);
        const indexAt = (ts) => {
            const d = this._toDate(ts);
            if (!d || !firstTs || !lastTs) return -1;
            const t = d.getTime();
            // Hors fenetre -> pas de pastille. Coller au bord ferait croire a
            // une operation qui n'a pas eu lieu la.
            if (t < firstTs.getTime() || t > lastTs.getTime()) return -1;
            let best = -1, bestD = Infinity;
            for (let i = 0; i < n; i++) {
                const dd = this._toDate(rows[i] && rows[i].ts);
                if (!dd) continue;
                const gap = Math.abs(dd.getTime() - t);
                if (gap < bestD) { bestD = gap; best = i; }
            }
            return best;
        };
        const placed = [];
        const pill = (idx, price, label, color) => {
            if (idx < 0 || price === null || price === undefined) return;
            ctx.font = '10px ' + mono;
            const tw = ctx.measureText(label).width;
            const w = Math.round(tw + 12), h = 16;
            const px = xOf(idx);
            let py = yOf(price) - 14;
            let x0 = Math.round(px - w / 2);
            if (x0 < plotX) x0 = plotX;
            if (x0 + w > plotX + plotW) x0 = plotX + plotW - w;
            // Anti-chevauchement : on remonte tant que ca se cogne (lecon carte MC).
            for (let guard = 0; guard < 8; guard++) {
                let hit = false;
                for (let j = 0; j < placed.length; j++) {
                    const r = placed[j];
                    if (x0 < r.x + r.w && x0 + w > r.x && py < r.y + r.h && py + h > r.y) { hit = true; break; }
                }
                if (!hit) break;
                py -= (h + 3);
            }
            if (py < priceY) py = priceY;
            placed.push({ x: x0, y: py, w: w, h: h });
            ctx.fillStyle = color;
            const r = 4;
            ctx.beginPath();
            ctx.moveTo(x0 + r, py);
            ctx.lineTo(x0 + w - r, py);
            ctx.quadraticCurveTo(x0 + w, py, x0 + w, py + r);
            ctx.lineTo(x0 + w, py + h - r);
            ctx.quadraticCurveTo(x0 + w, py + h, x0 + w - r, py + h);
            ctx.lineTo(x0 + r, py + h);
            ctx.quadraticCurveTo(x0, py + h, x0, py + h - r);
            ctx.lineTo(x0, py + r);
            ctx.quadraticCurveTo(x0, py, x0 + r, py);
            ctx.closePath();
            ctx.fill();
            // Pointe vers le point exact.
            const ty = yOf(price);
            ctx.beginPath();
            ctx.moveTo(px - 4, py + h);
            ctx.lineTo(px + 4, py + h);
            ctx.lineTo(px, Math.max(py + h, ty - 1));
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = C.panel;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x0 + w / 2, py + h / 2 + 0.5);
        };
        const buyTxt = Lang.t('paper.chart_buy');
        const sellTxt = Lang.t('paper.chart_sell');
        (ov.trades || []).forEach((t) => {
            pill(indexAt(t && t.entry_at), this._n(t && t.entry_price), buyTxt, C.up);
            pill(indexAt(t && t.exit_at), this._n(t && t.exit_price), sellTxt, C.down);
        });
        if (ov.entry && ov.entry.price !== null && ov.entry.price !== undefined) {
            pill(indexAt(ov.entry.at), this._n(ov.entry.price), buyTxt, C.up);
        }

        // --- crosshair + encart de lecture ---
        const hx = o.hoverX;
        if (hx === null || hx === undefined) return;
        let idx = (n > 1) ? Math.floor((hx - plotX) / step) : 0;
        if (idx < 0) idx = 0;
        if (idx > n - 1) idx = n - 1;
        const c = rows[idx];
        if (!c) return;
        const cx = Math.round(xOf(idx)) + 0.5;
        const cl = this._n(c.close);
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = C.strong;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, priceY);
        ctx.lineTo(cx, padT + totalH);
        ctx.stroke();
        if (cl !== null) {
            const cy = Math.round(yOf(cl)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(plotX, cy);
            ctx.lineTo(plotX + plotW, cy);
            ctx.stroke();
        }
        ctx.restore();

        const op = this._n(c.open);
        const prev = (idx > 0) ? this._n(rows[idx - 1].close) : null;
        const base = (prev !== null) ? prev : op;
        const chg = (base !== null && base !== 0 && cl !== null) ? ((cl - base) / base) * 100 : null;
        const intraday = (o.interval === '15m' || o.interval === '1h');
        const lines = [
            intraday ? this._dateTime(c.ts) : this._date(c.ts),
            'O ' + this._num(op, priceDec) + '  H ' + this._num(this._n(c.high), priceDec),
            'L ' + this._num(this._n(c.low), priceDec) + '  C ' + this._num(cl, priceDec),
        ];
        const vol = this._n(c.volume);
        if (vol !== null) lines.push(Lang.t('paper.chart_vol') + ' ' + this._num(vol, 0));
        ctx.font = '11px ' + mono;
        let boxW = 0;
        lines.forEach((L) => { boxW = Math.max(boxW, ctx.measureText(L).width); });
        const chgTxt = (chg === null) ? '' : this._signed(chg, 2, '%');
        if (chgTxt) boxW = Math.max(boxW, ctx.measureText(chgTxt).width);
        boxW = Math.round(boxW + 16);
        const lineH = 14;
        const boxH = lineH * (lines.length + (chgTxt ? 1 : 0)) + 10;
        ctx.globalAlpha = 0.94;
        ctx.fillStyle = C.panel;
        ctx.fillRect(plotX + 4, priceY + 4, boxW, boxH);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 1;
        ctx.strokeRect(plotX + 4.5, priceY + 4.5, boxW, boxH);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let ty = priceY + 9;
        ctx.fillStyle = C.fg;
        lines.forEach((L) => { ctx.fillText(L, plotX + 12, ty); ty += lineH; });
        if (chgTxt) {
            ctx.fillStyle = (chg > 0) ? C.up : ((chg < 0) ? C.down : C.muted);
            ctx.fillText(chgTxt, plotX + 12, ty);
        }
    },

    // =====================================================================
    //  LLM — plusieurs endpoints, jusqu'à 120 s : l'ATTENTE survit au re-rendu
    // =====================================================================
    //
    // L'état d'attente ne vit plus sur le bouton (détruit au premier re-rendu)
    // mais dans _busy, au niveau du module. Trois conséquences voulues :
    //   1. on peut changer d'onglet pendant que le coach réfléchit et retrouver
    //      le bouton en attente au retour ;
    //   2. un deuxième clic ne relance rien (une seule requête à la fois) ;
    //   3. la réponse arrive dans l'état du module, donc elle est visible au
    //      retour même si le corps a été réécrit dix fois entre-temps.

    _isBusy(key) {
        const k = String(key == null ? '' : key);
        return !!(Object.prototype.hasOwnProperty.call(this._busy, k) && this._busy[k]);
    },

    _busyLabel(key) {
        const k = String(key == null ? '' : key);
        return Lang.t(Object.prototype.hasOwnProperty.call(this._BUSY_LABEL, k)
            ? this._BUSY_LABEL[k] : 'paper.thinking');
    },

    _setBusy(key, on) {
        const k = String(key == null ? '' : key);
        if (!Object.prototype.hasOwnProperty.call(this._busy, k)) return;
        this._busy[k] = !!on;
        this._applyBusy();
    },

    // Réapplique l'état d'attente à TOUS les boutons marqués, corps ET panneau
    // flottant (qui vit hors du corps). Le libellé d'origine est mis de côté
    // sur le bouton lui-même : au retour, on le restitue exactement.
    _applyBusy() {
        const host = this._container;
        if (!host || !host.querySelectorAll) return;
        const nodes = host.querySelectorAll('[data-paper-busy]');
        Array.prototype.forEach.call(nodes, (el) => {
            const k = el.getAttribute('data-paper-busy');
            if (!Object.prototype.hasOwnProperty.call(this._busy, String(k))) return;
            if (this._busy[String(k)]) {
                if (el.getAttribute('data-busy-prev') === null) {
                    el.setAttribute('data-busy-prev', el.textContent);
                }
                el.disabled = true;
                el.textContent = this._busyLabel(k);
            } else {
                const prev = el.getAttribute('data-busy-prev');
                if (prev !== null) {
                    el.textContent = prev;
                    el.removeAttribute('data-busy-prev');
                }
                el.disabled = false;
            }
        });
    },

    // La réponse est là. Si l'utilisateur regarde l'onglet concerné, on redessine ;
    // sinon on le PRÉVIENT — le résultat l'attend au retour.
    _arrived(key) {
        const k = String(key == null ? '' : key);
        if (!Object.prototype.hasOwnProperty.call(this._BUSY_HOME, k)) { this._renderBody(); return; }
        const home = this._BUSY_HOME[k];
        if (this._tab === home[0]) { this._renderBody(); return; }
        this._toast('success', Lang.t(home[1]));
    },

    // key : la clé du registre (obligatoire — c'est elle qui porte l'attente).
    async _llm(key, url, body, apply) {
        const k = String(key == null ? '' : key);
        if (!Object.prototype.hasOwnProperty.call(this._busy, k)) return;
        // Anti double-clic : une seule requête à la fois par clé. On le DIT,
        // sinon un deuxième clic a l'air d'être tombé dans le vide.
        if (this._busy[k]) { this._toast('info', Lang.t('paper.busy_wait')); return; }
        this._setBusy(k, true);
        try {
            let r = null;
            try { r = await Auth.apiCall(url, { method: 'POST', body: JSON.stringify(body || {}) }); }
            catch (e) { r = null; }
            if (!r || !r.ok) { this._toast('error', await this._detail(r)); return; }
            let d = null;
            try { d = await r.json(); } catch (e) { d = null; }
            apply(d);
        } finally {
            this._setBusy(k, false);
        }
    },

    _llmText(d) {
        if (!d) return '';
        if (typeof d === 'string') return d;
        const v = this._pickField(d, ['text', 'message', 'answer', 'analysis', 'postmortem', 'report']);
        return v ? String(v) : '';
    },

    async ask() {
        const el = document.getElementById('paper-question');
        const q = el ? String(el.value || '').trim() : '';
        await this._llm('ask', '/api/paper/coach/ask', { question: q, lang: this._lang() }, (d) => {
            this._answer = this._llmText(d) || Lang.t('paper.no_data');
            this._arrived('ask');
        });
    },

    async analysis() {
        const el = document.getElementById('paper-analysis-sym');
        const sym = el ? String(el.value || '').trim() : '';
        if (!sym) { this._toast('warn', Lang.t('paper.symbol_required')); return; }
        this._analysisSymbol = sym;
        await this._llm('analysis', '/api/paper/analysis', { symbol: sym, lang: this._lang() }, (d) => {
            this._analysis = this._llmText(d) || Lang.t('paper.no_data');
            this._arrived('analysis');
        });
    },

    async postmortem(idx) {
        const body = { lang: this._lang() };
        if (idx !== null && idx !== undefined) body.trade_index = idx;
        await this._llm('postmortem', '/api/paper/postmortem', body, (d) => {
            this._postmortem = this._llmText(d) || Lang.t('paper.no_data');
            this._arrived('postmortem');
        });
    },

    // =====================================================================
    //  COACH FLOTTANT — une question, d'où qu'on soit dans le module
    // =====================================================================
    //
    // Le coach vivait dans son onglet : poser une question depuis le Journal ou
    // le Plan obligeait à tout quitter. Le bouton rond en bas à droite ouvre un
    // petit panneau qui pose la MÊME question au MÊME endpoint, avec le même
    // registre d'attente (_busy.ask) — on peut donc le refermer pendant que le
    // coach réfléchit et le rouvrir pour lire la réponse.
    //
    // UN SEUL échange est montré : l'historique complet vit déjà dans le carnet
    // (Discussions.md), et c'est dit à l'écran.

    _fabHtml() {
        if (!this._fabOpen) {
            return '<button class="paper-fab" data-paper-act="fab-toggle" ' +
                       'title="' + esc(Lang.t('paper.fab_open')) + '">' +
                esc(Lang.t('paper.fab_btn')) + '</button>';
        }
        const ex = this._fabAnswer;
        return '<div class="paper-fab-panel">' +
            '<div class="paper-fab-head">' +
              '<span style="flex:1 1 auto;min-width:0;font-size:14px;font-weight:600;">' +
                esc(Lang.t('paper.fab_title')) + '</span>' +
              '<button class="btn btn-ghost btn-sm" data-paper-act="fab-toggle" ' +
                  'style="padding:0 6px;" title="' + esc(Lang.t('paper.close')) + '">' +
                esc(Lang.t('paper.close_mark')) + '</button>' +
            '</div>' +
            '<div class="paper-fab-body">' +
              (ex
                ? '<div style="margin-bottom:10px;">' +
                    '<div style="font-size:12px;color:var(--text-dim);line-height:1.45;' +
                         'margin-bottom:4px;">' + esc(String(ex.q || '')) + '</div>' +
                    '<div style="font-size:13px;line-height:1.6;white-space:pre-wrap;' +
                         'word-break:break-word;">' + esc(String(ex.a || '')) + '</div>' +
                  '</div>'
                : '<div style="font-size:13px;color:var(--text-muted);line-height:1.5;' +
                       'margin-bottom:10px;">' + esc(Lang.t('paper.fab_hint')) + '</div>') +
            '</div>' +
            '<div class="paper-fab-foot">' +
              '<textarea id="paper-fab-q" class="form-input" rows="2" ' +
                   'style="resize:vertical;line-height:1.5;font-size:13px;" ' +
                   'placeholder="' + esc(Lang.t('paper.ask_placeholder')) + '">' +
                esc(this._fabQ || '') + '</textarea>' +
              '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;">' +
                '<button class="btn btn-primary btn-sm" data-paper-act="fab-ask" ' +
                    'data-paper-busy="ask">' + esc(Lang.t('paper.ask_send')) + '</button>' +
                '<span style="font-size:11px;color:var(--text-dim);line-height:1.4;">' +
                  esc(Lang.t('paper.fab_history')) + '</span>' +
              '</div>' +
            '</div>' +
        '</div>';
    },

    _paintFab() {
        const host = document.getElementById('paper-fab-wrap');
        if (!host) return;
        host.innerHTML = this._fabHtml();
        // Le panneau vient d'être (re)dessiné : si une question est en vol, son
        // bouton doit repartir en attente (même mécanisme que le corps).
        this._applyBusy();
    },

    _removeFab() {
        const host = document.getElementById('paper-fab-wrap');
        if (host) host.innerHTML = '';
        this._fabOpen = false;
    },

    toggleFab() {
        this._fabOpen = !this._fabOpen;
        this._paintFab();
        if (!this._fabOpen) return;
        const el = document.getElementById('paper-fab-q');
        if (el && el.focus) { try { el.focus(); } catch (e) { /* focus refusé */ } }
    },

    async fabAsk() {
        const el = document.getElementById('paper-fab-q');
        const q = el ? String(el.value || '').trim() : String(this._fabQ || '').trim();
        if (!q) { this._toast('warn', Lang.t('paper.fab_empty')); return; }
        this._fabQ = q;
        await this._llm('ask', '/api/paper/coach/ask', { question: q, lang: this._lang() }, (d) => {
            const txt = this._llmText(d) || Lang.t('paper.no_data');
            this._fabAnswer = { q: q, a: txt };
            this._fabQ = '';
            this._paintFab();
            // Panneau refermé pendant la réflexion : on le dit, et on dit OÙ —
            // la réponse attend dans le panneau flottant, pas dans l'onglet Coach.
            if (!this._fabOpen) this._toast('success', Lang.t('paper.ready_fab'));
        });
    },

    // =====================================================================
    //  Délégation d'événements
    // =====================================================================

    _click(ev) {
        const t = (ev.target && ev.target.closest) ? ev.target : null;
        if (!t) return;
        const tab = t.closest('[data-paper-tab]');
        if (tab) { ev.preventDefault(); this.switchTab(tab.getAttribute('data-paper-tab')); return; }
        const el = t.closest('[data-paper-act]');
        if (!el) return;
        const act = el.getAttribute('data-paper-act');
        ev.preventDefault();
        if (act === 'refresh') { this.refresh(); return; }
        if (act === 'pick') {
            this.pick(el.getAttribute('data-sym'), el.getAttribute('data-name'),
                el.getAttribute('data-cur'), el.getAttribute('data-exch'));
            return;
        }
        if (act === 'submit-order') { this.submitOrder(); return; }
        if (act === 'close-pos') { this.closePosition(el.getAttribute('data-sym')); return; }
        if (act === 'cancel-order') { this.cancelOrder(el.getAttribute('data-id')); return; }
        if (act === 'open-trade') {
            const i = parseInt(el.getAttribute('data-idx'), 10);
            this._tradeIdx = (this._tradeIdx === i) ? null : (isFinite(i) ? i : null);
            this._postmortem = null;
            this._renderBody();
            return;
        }
        if (act === 'close-trade') { this._tradeIdx = null; this._postmortem = null; this._renderBody(); return; }
        if (act === 'postmortem') {
            const i = parseInt(el.getAttribute('data-idx'), 10);
            this.postmortem(isFinite(i) ? i : null);
            return;
        }
        if (act === 'ask') { this.ask(); return; }
        if (act === 'analysis') { this.analysis(); return; }
        if (act === 'ideas') { this.askIdeas(); return; }
        if (act === 'journal-toggle') { this.toggleJournal(el.getAttribute('data-id')); return; }
        if (act === 'review') { this.reviewPositions(); return; }
        if (act === 'review-text') { this._reviewOpen = !this._reviewOpen; this._renderBody(); return; }
        if (act === 'alerts-mode') { this.setAlertsMode(el.getAttribute('data-mode')); return; }
        if (act === 'sym-close') { this.closeSymIdeas(el.getAttribute('data-sym')); return; }
        if (act === 'sym-text') { this.toggleSymText(el.getAttribute('data-key')); return; }
        if (act === 'sym-all') { this.switchTab('coach'); return; }
        if (act === 'fab-toggle') { this.toggleFab(); return; }
        if (act === 'fab-ask') { this.fabAsk(); return; }
        if (act === 'chart-reload') { this.reloadChart(el.getAttribute('data-sym')); return; }
        if (act === 'idea-level') { this.setLevel(el.getAttribute('data-level')); return; }
        if (act === 'idea-pick') { this.useIdea(el.getAttribute('data-sym')); return; }
        if (act === 'watch-add') { this.addWatch(el.getAttribute('data-sym')); return; }
        if (act === 'watch-add-analysis') {
            const inp = document.getElementById('paper-analysis-sym');
            this.addWatch(inp ? String(inp.value || '').trim() : '');
            return;
        }
        if (act === 'watch-remove') { this.removeWatch(el.getAttribute('data-sym')); return; }
        if (act === 'watch-analyze') { this.analyzeSymbol(el.getAttribute('data-sym')); return; }
        if (act === 'watch-trade') { this.openTrade(el.getAttribute('data-sym')); return; }
        if (act === 'note-owner') { this.selectNoteOwner(el.getAttribute('data-owner')); return; }
        if (act === 'open-note') { this.openNote(el.getAttribute('data-note')); return; }
        if (act === 'close-note') { this._noteName = null; this._noteBody = null; this._renderBody(); return; }
        if (act === 'open-lesson') {
            this._lessonId = el.getAttribute('data-lesson');
            this._quizResult = null;
            this._renderBody();
            return;
        }
        if (act === 'close-lesson') {
            this._lessonId = null; this._quizResult = null; this._renderBody(); return;
        }
        if (act === 'quiz-submit') { this.submitQuiz(el.getAttribute('data-lesson')); return; }
        if (act === 'arena-accept') { this.acceptArena(); return; }
        if (act === 'reset') { this.resetPortfolio(); return; }
        if (act === 'whale-pick') { this.openWhale(el.getAttribute('data-whale')); return; }
        if (act === 'radar-run') { this.runRadar(); return; }
        if (act === 'plan-add') { this.addPipeline(); return; }
        if (act === 'plan-stage') {
            this.setPipelineStage(el.getAttribute('data-id'), el.getAttribute('data-stage'));
            return;
        }
        if (act === 'plan-del') { this.removePipeline(el.getAttribute('data-id')); return; }
        if (act === 'plan-trade') { this.openTrade(el.getAttribute('data-sym')); return; }
        if (act === 'plan-scn-gen') { this.generateScenarios(); return; }
        if (act === 'plan-branch') {
            this.resolveBranch(el.getAttribute('data-tree'), el.getAttribute('data-branch'),
                el.getAttribute('data-status'));
            return;
        }
        if (act === 'plan-scn-del') { this.deleteScenario(el.getAttribute('data-tree')); return; }
        if (act === 'plan-arch') { this._planArchOpen = !this._planArchOpen; this._renderBody(); return; }
        if (act === 'graph-all') { this.focusGraph(null); return; }
        if (act === 'graph-focus') { this.focusGraph(el.getAttribute('data-sym')); return; }
        // « Actualiser » rafraîchit CE QU'ON REGARDE : dans un bosquet, sa liste
        // (la source de tous ses niveaux), et le chemin ouvert est conservé ;
        // ailleurs, la toile elle-même.
        if (act === 'graph-reload') {
            const gk = this._groveKindOf(this._graphPivot);
            if (gk) { this._groveFetch(gk, true); return; }
            this.loadGraph(this._graphSymbol);
            return;
        }
        if (act === 'graph-open') { this.openGraph(el.getAttribute('data-sym')); return; }
        // Fil d'Ariane : les valeurs viennent du DOM, donc de nulle part de sûr
        // — c'est _drillPlan qui les confronte aux données et retombe au niveau
        // du dessus quand elles ne désignent rien.
        if (act === 'gdrill') {
            this.drillTo(el.getAttribute('data-fam'), el.getAttribute('data-theme'),
                el.getAttribute('data-sub'));
            return;
        }
        if (act === 'grove-close') { this.closeGrove(); return; }
        if (act === 'chart-range') {
            this.setChartRange(el.getAttribute('data-ctx'), el.getAttribute('data-range'));
            return;
        }
        if (act === 'pos-toggle') {
            const sy = el.getAttribute('data-sym');
            const opening = (this._posOpen !== sy);
            this._posOpen = opening ? sy : null;
            this._renderBody();
            // Deplier le graphique d'une position, c'est se demander « qu'est-ce
            // que le coach avait dit de ce titre ? » : on va lire sa MEMOIRE
            // (aucun appel LLM, aucune depense) et on n'affiche rien s'il n'a
            // jamais rien dit. Meme geste pour la toile : un compteur, muet a 0.
            if (opening) { this._loadSymIdeas(sy); this._loadGraphCount(sy); }
        }
    },

    _input(ev) {
        const el = ev.target;
        if (!el || !el.getAttribute) return;
        if (el.id === 'paper-q') {
            const v = el.value;
            this._form.q = v;
            if (this._searchTimer) clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => { this._searchTimer = null; this.search(v); }, 400);
            return;
        }
        // Ce champ vit HORS du corps re-rendu : sa valeur est recopiée dans
        // l'état du module à la frappe, sinon un re-rendu du corps (poll de
        // 60 s) la laisserait derrière.
        if (el.id === 'paper-fab-q') { this._fabQ = el.value; return; }
        // Brouillon de l'ordre : tout ce qui est tapé part sur le disque, par
        // titre, à l'anti-rebond. C'est ce qui rend un rechargement inoffensif.
        if (Object.prototype.hasOwnProperty.call(this._FORM_IDS, String(el.id || ''))) {
            this._captureForm();
            this._queueDraft();
        }
        if (el.getAttribute && el.getAttribute('data-paper-size')) {
            this._captureForm();
            // Changer le type d'ordre fait apparaître/disparaître le champ de
            // prix : là seulement on redessine.
            if (el.id === 'paper-kind') { this._renderBody(); return; }
            this._paintSizing();
        }
    },
};
