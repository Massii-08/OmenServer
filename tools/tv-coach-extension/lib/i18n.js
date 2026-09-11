/**
 * lib/i18n.js — les chaînes du panneau en FR / IT / EN (PUR).
 *
 * La langue est celle d'OmenServer : ``content-omen.js`` lit ``omen-lang``
 * dans le localStorage du site en même temps que le token et la range dans
 * ``chrome.storage.local``. Les options permettent de la forcer.
 *
 * Règle de parité : les trois dictionnaires ont EXACTEMENT les mêmes clés
 * (test ``tests/i18n.test.js``). Une clé absente rend la clé elle-même — une
 * chaîne manquante doit se voir à l'écran, pas se traduire en vide silencieux.
 *
 * Aucun emoji dans les valeurs : le panneau est en texte et en glyphes SVG.
 */
(function () {
  'use strict';

  var DEFAULT_LANG = 'fr';
  var LANGS = ['fr', 'it', 'en'];

  var STRINGS = {
    fr: {
      'panel.title': 'Coach OmenServer',
      'panel.collapse': 'Replier',
      'panel.expand': 'Ouvrir le coach',
      'panel.options': 'Options',
      'panel.refresh': 'Rafraîchir',
      'panel.loading': 'Chargement de la fiche...',
      'panel.updated_at': 'Fiche de {time}',
      'panel.mode.swing': 'swing',
      'panel.mode.scalp': 'scalp',
      'panel.no_symbol': 'Aucun graphique détecté.',
      'panel.price': 'Prix',
      'panel.bid': 'Vente',
      'panel.ask': 'Achat',
      'panel.spread': 'Écart',
      'panel.degraded': 'Sources muettes : {list}',

      'banner.symbol_unknown': 'Titre non suivi par l’Omen ({tv}).',
      'banner.no_fee_profile': 'Frais non configurés : choisis ton profil dans les options.',
      'banner.server_down': 'Omen injoignable — fiche en cache, ticket verrouillé.',
      'banner.token_missing': 'Pas de token : connecte l’extension depuis omenserver.org.',
      'banner.token_expired': 'Session expirée — reconnecte-toi sur omenserver.org, puis clique « Connecter l’extension coach ».',
      'banner.draw_login': 'Connecte-toi à TradingView pour le dessin.',
      'banner.draw_unavailable': 'Dessin indisponible sur cette page.',
      'banner.scalp_modules_missing': 'Modules du mode scalp absents (bars/guards/ledger).',

      'section.position': 'Ta position',
      'section.coach': 'Le coach',
      'section.news': 'Dépêches',
      'section.agenda': 'Agenda',
      'section.alerts': 'Alertes',
      'section.ticket': 'Ticket',
      'section.guards': 'Garde-fous',
      'section.ledger': 'Scalp en cours',

      'position.none': 'Aucune position sur ce titre.',
      'position.long': 'long',
      'position.short': 'short',
      'position.qty': 'Quantité',
      'position.avg': 'Prix de revient',
      'position.stop': 'Stop',
      'position.target': 'Cible',
      'position.pnl': 'P&L',

      'coach.position_none': 'Le coach n’a pas de position sur ce titre.',
      'coach.position': 'Position du coach',
      'coach.ideas': 'Idées',
      'coach.ideas_none': 'Aucune idée en cours.',
      'coach.hypotheses': 'Paris ouverts',
      'coach.hypotheses_none': 'Aucun pari ouvert.',
      'coach.ask': 'Conseil',
      'coach.ask_pending': 'Le coach réfléchit (~1 min)...',
      'coach.ask_error': 'Le coach n’a pas répondu : {error}',
      'coach.ask_hint': 'Réponse en une minute environ.',
      'coach.review': 'Bilan de session',

      'news.none': 'Aucune dépêche récente.',
      'agenda.none': 'Rien à l’agenda.',
      'alerts.none': 'Aucune alerte sur ce titre.',
      'alerts.above': 'au-dessus de {price}',
      'alerts.below': 'en dessous de {price}',
      'alerts.fired': 'Alerte : {symbol} {condition} (prix {price}).',

      'chip.vix': 'VIX',
      'chip.fng': 'Peur/Avidité',
      'chip.dvol': 'DVOL',
      'chip.funding': 'Funding',
      'chip.next_funding': 'Prochain funding',
      'chip.oi': 'Intérêt ouvert',
      'chip.premium': 'Prime Coinbase',
      'chip.cme_gap': 'Gap CME',
      'chip.liquidations': 'Liquidations',
      'chip.mute': 'source muette',

      'ticket.buy': 'Acheter',
      'ticket.sell': 'Vendre',
      'ticket.qty': 'Quantité',
      'ticket.stop': 'Stop',
      'ticket.target': 'Cible',
      'ticket.confirm': 'Confirmer',
      'ticket.confirm_anyway': 'Passer quand même',
      'ticket.cancel': 'Annuler',
      'ticket.sent': 'Ordre envoyé.',
      'ticket.error': 'Ordre refusé : {error}',
      'ticket.needs_confirm': 'Le serveur prévient : {codes}',
      'ticket.fees': 'Frais A/R',
      'ticket.risk': 'Risque',
      'ticket.r_multiple': 'R',
      'ticket.move_to_beat': 'Mouvement à battre',
      'ticket.locked': 'Ticket verrouillé.',
      'ticket.computing': 'Calcul...',

      'scalp.open': 'Ouvrir le scalp',
      'scalp.close': 'Sortir',
      'scalp.running': 'Scalp ouvert depuis {duration}',
      'scalp.result': 'Résultat',
      'scalp.queued': 'Scalp gardé en file locale (Omen injoignable).',
      'scalp.sent': 'Scalp enregistré.',
      'scalp.mae': 'Pire creux',
      'scalp.mfe': 'Meilleur pic',
      'scalp.no_profile': 'Choisis un profil de frais avant d’ouvrir un scalp.',
      'scalp.size_auto': 'Taille auto : {qty} ≈ {notional} CHF · frais A/R ≈ {fees} CHF',
      'scalp.size_none': 'Capital insuffisant pour une unité à ce prix : scalp refusé.',

      'guard.all_clear': 'Rien ne s’oppose à ce scalp.',
      'guard.event_risk': 'Événement macro imminent — écarte-toi.',
      'guard.funding_soon': 'Règlement du funding dans moins de 5 minutes.',
      'guard.flash_news': 'Dépêche il y a moins de 2 minutes.',
      'guard.vol_spike': 'Volatilité 1 min au double de sa médiane.',
      'guard.spread_wide': 'Écart achat/vente au double de sa médiane.',
      'guard.fee_coverage': 'Ce scalp doit gagner {required_pct} % pour payer le courtier.',
      'guard.cooldown': 'Dernier scalp perdant il y a moins de 10 minutes.',
      'guard.pace': 'Plus de 6 scalps dans l’heure.',
      'guard.daily_loss': 'Perte du jour au-delà de 2 % — stop pour aujourd’hui.',

      'warn.no_stop': 'Pas de stop.',
      'warn.oversized': 'Position trop grosse.',
      'warn.fee_ratio': 'Frais lourds face au gain visé.',
      'warn.stop_in_noise': 'Stop dans le bruit.',
      'warn.concentration': 'Concentration élevée.',
      'warn.revenge_trade': 'Trade de revanche.',
      'warn.overtrading': 'Trop de trades.',
      'warn.cash_floor': 'Trésorerie trop basse.',

      'draw.levels': 'Dessiner les niveaux',
      'draw.bets': 'Dessiner les paris',
      'draw.clear': 'Effacer',
      'draw.done': '{n} tracés posés.',
      'draw.no_bets': 'Le coach n’a aucun pari ouvert sur ce titre : rien à dessiner.',
      'draw.no_levels': 'Aucun niveau à dessiner : ouvre d’abord un ticket ou une position.',

      'section.watchlist': 'Watchlist',
      'watchlist.import': 'Importer la watchlist',
      'watchlist.hint': 'Un seul sens : TradingView vers tes favoris OmenServer.',
      'watchlist.reading': 'Lecture de la watchlist TradingView...',
      'watchlist.not_found': 'Watchlist TradingView introuvable sur cette page.',
      'watchlist.empty': 'Aucun symbole dans la watchlist affichée.',
      'watchlist.importing': 'Import en cours ({done}/{total})...',
      'watchlist.done': '{added} importés, {skipped} ignorés, {unknown} inconnus.',
      'watchlist.unknown_list': 'Inconnus : {list}',
      'watchlist.capped': 'Import limité à {cap} titres.',
      'watchlist.failed': 'Import interrompu : {error}',

      'alert.title': 'Nouvelle alerte',
      'alert.price': 'Niveau',
      'alert.op_above': 'Au-dessus',
      'alert.op_below': 'En dessous',
      'alert.create': 'Créer',
      'alert.cancel': 'Annuler',
      'alert.created': 'Alerte posée : {condition}.',
      'alert.error': 'Alerte refusée : {error}',
      'alert.already_true': 'Ce niveau est déjà franchi : le serveur refusera.',
      'alert.hint': 'Alt+clic sur le graphique pose une alerte à ce niveau.',
      'alert.no_symbol': 'Titre non suivi : alerte impossible.',

      'note.title': 'Note rapide',
      'note.placeholder': 'Une ligne au carnet d’idées...',
      'note.send': 'Noter',
      'note.sent': 'Noté.',
      'note.error': 'Note refusée : {error}',
      'note.hint': 'Ctrl+Entrée envoie ({left} caractères restants).',

      'review.auto_pending': 'Bilan automatique en cours (20 min sans scalp)...',
      'review.auto_done': 'Bilan automatique après 20 minutes sans scalp.',
      'review.capped': 'Plafond de bilans atteint : rien avant demain.',

      'ads.closed': 'Pubs fermées : {n}',

      'options.title': 'Options du coach',
      'options.fee_profile': 'Profil de frais',
      'options.fee_profile_hint': 'Sans profil, le ticket refuse d’ouvrir un scalp.',
      'options.custom_pct': 'Frais personnalisés (% par côté)',
      'options.risk_pct': 'Risque par trade (%)',
      'options.lang': 'Langue',
      'options.scalp_auto': 'Mode scalp automatique sous 5 min',
      'options.ads_auto_close': 'Fermer automatiquement les pubs TradingView (coin bas gauche et pop-up « sans pub »)',
      'options.api_base': 'URL de l’Omen',
      'options.token': 'Token (collage manuel)',
      'options.token_hint': 'Le bouton « Connecter » sur omenserver.org le remplit tout seul. Laisse vide pour garder le jeton actuel.',
      'options.save': 'Enregistrer',
      'options.saved': 'Enregistré.',
      'options.reload': 'Recharger l’extension',
      'options.reload_hint': 'Après une mise à jour des fichiers de l’extension (équivaut au ↻ de chrome://extensions). Recharge ensuite l’onglet TradingView.',
      'options.choose_fee_profile': 'Choisis ton profil de frais pour commencer.',
      'options.connected': 'Extension connectée à {base}.'
    },

    it: {
      'panel.title': 'Coach OmenServer',
      'panel.collapse': 'Riduci',
      'panel.expand': 'Apri il coach',
      'panel.options': 'Opzioni',
      'panel.refresh': 'Aggiorna',
      'panel.loading': 'Caricamento della scheda...',
      'panel.updated_at': 'Scheda delle {time}',
      'panel.mode.swing': 'swing',
      'panel.mode.scalp': 'scalp',
      'panel.no_symbol': 'Nessun grafico rilevato.',
      'panel.price': 'Prezzo',
      'panel.bid': 'Denaro',
      'panel.ask': 'Lettera',
      'panel.spread': 'Spread',
      'panel.degraded': 'Fonti mute: {list}',

      'banner.symbol_unknown': 'Titolo non seguito dall’Omen ({tv}).',
      'banner.no_fee_profile': 'Commissioni non configurate: scegli il profilo nelle opzioni.',
      'banner.server_down': 'Omen irraggiungibile — scheda in cache, ticket bloccato.',
      'banner.token_missing': 'Nessun token: collega l’estensione da omenserver.org.',
      'banner.token_expired': 'Sessione scaduta — riconnettiti su omenserver.org, poi clicca « Collega l’estensione coach ».',
      'banner.draw_login': 'Accedi a TradingView per disegnare.',
      'banner.draw_unavailable': 'Disegno non disponibile su questa pagina.',
      'banner.scalp_modules_missing': 'Moduli scalp assenti (bars/guards/ledger).',

      'section.position': 'La tua posizione',
      'section.coach': 'Il coach',
      'section.news': 'Notizie',
      'section.agenda': 'Agenda',
      'section.alerts': 'Avvisi',
      'section.ticket': 'Ticket',
      'section.guards': 'Paletti',
      'section.ledger': 'Scalp in corso',

      'position.none': 'Nessuna posizione su questo titolo.',
      'position.long': 'lungo',
      'position.short': 'corto',
      'position.qty': 'Quantità',
      'position.avg': 'Prezzo di carico',
      'position.stop': 'Stop',
      'position.target': 'Obiettivo',
      'position.pnl': 'P&L',

      'coach.position_none': 'Il coach non ha posizioni su questo titolo.',
      'coach.position': 'Posizione del coach',
      'coach.ideas': 'Idee',
      'coach.ideas_none': 'Nessuna idea in corso.',
      'coach.hypotheses': 'Scommesse aperte',
      'coach.hypotheses_none': 'Nessuna scommessa aperta.',
      'coach.ask': 'Consiglio',
      'coach.ask_pending': 'Il coach sta pensando (~1 min)...',
      'coach.ask_error': 'Il coach non ha risposto: {error}',
      'coach.ask_hint': 'Risposta in circa un minuto.',
      'coach.review': 'Bilancio di sessione',

      'news.none': 'Nessuna notizia recente.',
      'agenda.none': 'Niente in agenda.',
      'alerts.none': 'Nessun avviso su questo titolo.',
      'alerts.above': 'sopra {price}',
      'alerts.below': 'sotto {price}',
      'alerts.fired': 'Avviso: {symbol} {condition} (prezzo {price}).',

      'chip.vix': 'VIX',
      'chip.fng': 'Paura/Avidità',
      'chip.dvol': 'DVOL',
      'chip.funding': 'Funding',
      'chip.next_funding': 'Prossimo funding',
      'chip.oi': 'Interesse aperto',
      'chip.premium': 'Premio Coinbase',
      'chip.cme_gap': 'Gap CME',
      'chip.liquidations': 'Liquidazioni',
      'chip.mute': 'fonte muta',

      'ticket.buy': 'Compra',
      'ticket.sell': 'Vendi',
      'ticket.qty': 'Quantità',
      'ticket.stop': 'Stop',
      'ticket.target': 'Obiettivo',
      'ticket.confirm': 'Conferma',
      'ticket.confirm_anyway': 'Procedi comunque',
      'ticket.cancel': 'Annulla',
      'ticket.sent': 'Ordine inviato.',
      'ticket.error': 'Ordine rifiutato: {error}',
      'ticket.needs_confirm': 'Il server avverte: {codes}',
      'ticket.fees': 'Commissioni A/R',
      'ticket.risk': 'Rischio',
      'ticket.r_multiple': 'R',
      'ticket.move_to_beat': 'Movimento da battere',
      'ticket.locked': 'Ticket bloccato.',
      'ticket.computing': 'Calcolo...',

      'scalp.open': 'Apri lo scalp',
      'scalp.close': 'Esci',
      'scalp.running': 'Scalp aperto da {duration}',
      'scalp.result': 'Risultato',
      'scalp.queued': 'Scalp tenuto in coda locale (Omen irraggiungibile).',
      'scalp.sent': 'Scalp registrato.',
      'scalp.mae': 'Peggior ribasso',
      'scalp.mfe': 'Miglior rialzo',
      'scalp.no_profile': 'Scegli un profilo di commissioni prima di aprire uno scalp.',
      'scalp.size_auto': 'Taglia automatica: {qty} ≈ {notional} CHF · commissioni A/R ≈ {fees} CHF',
      'scalp.size_none': 'Capitale insufficiente per un’unità a questo prezzo: scalp rifiutato.',

      'guard.all_clear': 'Niente osta a questo scalp.',
      'guard.event_risk': 'Evento macro imminente — stai fuori.',
      'guard.funding_soon': 'Regolamento del funding tra meno di 5 minuti.',
      'guard.flash_news': 'Notizia da meno di 2 minuti.',
      'guard.vol_spike': 'Volatilità 1 min al doppio della mediana.',
      'guard.spread_wide': 'Spread al doppio della mediana.',
      'guard.fee_coverage': 'Questo scalp deve guadagnare {required_pct} % per pagare il broker.',
      'guard.cooldown': 'Ultimo scalp perdente meno di 10 minuti fa.',
      'guard.pace': 'Più di 6 scalp in un’ora.',
      'guard.daily_loss': 'Perdita del giorno oltre il 2 % — stop per oggi.',

      'warn.no_stop': 'Nessuno stop.',
      'warn.oversized': 'Posizione troppo grande.',
      'warn.fee_ratio': 'Commissioni pesanti rispetto al guadagno atteso.',
      'warn.stop_in_noise': 'Stop dentro il rumore.',
      'warn.concentration': 'Concentrazione elevata.',
      'warn.revenge_trade': 'Trade di rivincita.',
      'warn.overtrading': 'Troppi trade.',
      'warn.cash_floor': 'Liquidità troppo bassa.',

      'draw.levels': 'Disegna i livelli',
      'draw.bets': 'Disegna le scommesse',
      'draw.clear': 'Cancella',
      'draw.done': '{n} tracciati posati.',
      'draw.no_bets': 'Il coach non ha scommesse aperte su questo titolo: niente da disegnare.',
      'draw.no_levels': 'Nessun livello da disegnare: apri prima un ticket o una posizione.',

      'section.watchlist': 'Watchlist',
      'watchlist.import': 'Importa la watchlist',
      'watchlist.hint': 'Un solo senso: da TradingView ai tuoi preferiti OmenServer.',
      'watchlist.reading': 'Lettura della watchlist TradingView...',
      'watchlist.not_found': 'Watchlist TradingView non trovata in questa pagina.',
      'watchlist.empty': 'Nessun simbolo nella watchlist mostrata.',
      'watchlist.importing': 'Importazione in corso ({done}/{total})...',
      'watchlist.done': '{added} importati, {skipped} ignorati, {unknown} sconosciuti.',
      'watchlist.unknown_list': 'Sconosciuti: {list}',
      'watchlist.capped': 'Importazione limitata a {cap} titoli.',
      'watchlist.failed': 'Importazione interrotta: {error}',

      'alert.title': 'Nuovo avviso',
      'alert.price': 'Livello',
      'alert.op_above': 'Sopra',
      'alert.op_below': 'Sotto',
      'alert.create': 'Crea',
      'alert.cancel': 'Annulla',
      'alert.created': 'Avviso posato: {condition}.',
      'alert.error': 'Avviso rifiutato: {error}',
      'alert.already_true': 'Questo livello è già superato: il server rifiuterà.',
      'alert.hint': 'Alt+clic sul grafico posa un avviso a quel livello.',
      'alert.no_symbol': 'Titolo non seguito: avviso impossibile.',

      'note.title': 'Nota rapida',
      'note.placeholder': 'Una riga sul taccuino delle idee...',
      'note.send': 'Annota',
      'note.sent': 'Annotato.',
      'note.error': 'Nota rifiutata: {error}',
      'note.hint': 'Ctrl+Invio invia ({left} caratteri rimasti).',

      'review.auto_pending': 'Bilancio automatico in corso (20 min senza scalp)...',
      'review.auto_done': 'Bilancio automatico dopo 20 minuti senza scalp.',
      'review.capped': 'Limite di bilanci raggiunto: nulla prima di domani.',

      'ads.closed': 'Pubblicità chiuse: {n}',

      'options.title': 'Opzioni del coach',
      'options.fee_profile': 'Profilo di commissioni',
      'options.fee_profile_hint': 'Senza profilo il ticket rifiuta di aprire uno scalp.',
      'options.custom_pct': 'Commissioni personalizzate (% per lato)',
      'options.risk_pct': 'Rischio per trade (%)',
      'options.lang': 'Lingua',
      'options.scalp_auto': 'Modo scalp automatico sotto i 5 min',
      'options.ads_auto_close': 'Chiudi automaticamente le pubblicità di TradingView (angolo in basso a sinistra e pop-up « senza pubblicità »)',
      'options.api_base': 'URL dell’Omen',
      'options.token': 'Token (incolla manuale)',
      'options.token_hint': 'Il pulsante « Collega » su omenserver.org lo riempie da solo. Lascia vuoto per mantenere il token attuale.',
      'options.save': 'Salva',
      'options.saved': 'Salvato.',
      'options.reload': 'Ricarica l’estensione',
      'options.reload_hint': 'Dopo un aggiornamento dei file dell’estensione (equivale al ↻ di chrome://extensions). Poi ricarica la scheda TradingView.',
      'options.choose_fee_profile': 'Scegli il profilo di commissioni per iniziare.',
      'options.connected': 'Estensione collegata a {base}.'
    },

    en: {
      'panel.title': 'OmenServer Coach',
      'panel.collapse': 'Collapse',
      'panel.expand': 'Open the coach',
      'panel.options': 'Options',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Loading the brief...',
      'panel.updated_at': 'Brief from {time}',
      'panel.mode.swing': 'swing',
      'panel.mode.scalp': 'scalp',
      'panel.no_symbol': 'No chart detected.',
      'panel.price': 'Price',
      'panel.bid': 'Bid',
      'panel.ask': 'Ask',
      'panel.spread': 'Spread',
      'panel.degraded': 'Silent sources: {list}',

      'banner.symbol_unknown': 'Symbol not tracked by the Omen ({tv}).',
      'banner.no_fee_profile': 'Fees not configured: pick your profile in the options.',
      'banner.server_down': 'Omen unreachable — cached brief, ticket locked.',
      'banner.token_missing': 'No token: connect the extension from omenserver.org.',
      'banner.token_expired': 'Session expired — sign in again on omenserver.org, then click “Connect the coach extension”.',
      'banner.draw_login': 'Sign in to TradingView to draw.',
      'banner.draw_unavailable': 'Drawing unavailable on this page.',
      'banner.scalp_modules_missing': 'Scalp modules missing (bars/guards/ledger).',

      'section.position': 'Your position',
      'section.coach': 'The coach',
      'section.news': 'News',
      'section.agenda': 'Agenda',
      'section.alerts': 'Alerts',
      'section.ticket': 'Ticket',
      'section.guards': 'Guardrails',
      'section.ledger': 'Open scalp',

      'position.none': 'No position on this symbol.',
      'position.long': 'long',
      'position.short': 'short',
      'position.qty': 'Quantity',
      'position.avg': 'Average price',
      'position.stop': 'Stop',
      'position.target': 'Target',
      'position.pnl': 'P&L',

      'coach.position_none': 'The coach holds nothing on this symbol.',
      'coach.position': 'Coach position',
      'coach.ideas': 'Ideas',
      'coach.ideas_none': 'No open idea.',
      'coach.hypotheses': 'Open bets',
      'coach.hypotheses_none': 'No open bet.',
      'coach.ask': 'Advice',
      'coach.ask_pending': 'The coach is thinking (~1 min)...',
      'coach.ask_error': 'The coach did not answer: {error}',
      'coach.ask_hint': 'Answer in about a minute.',
      'coach.review': 'Session review',

      'news.none': 'No recent news.',
      'agenda.none': 'Nothing on the agenda.',
      'alerts.none': 'No alert on this symbol.',
      'alerts.above': 'above {price}',
      'alerts.below': 'below {price}',
      'alerts.fired': 'Alert: {symbol} {condition} (price {price}).',

      'chip.vix': 'VIX',
      'chip.fng': 'Fear/Greed',
      'chip.dvol': 'DVOL',
      'chip.funding': 'Funding',
      'chip.next_funding': 'Next funding',
      'chip.oi': 'Open interest',
      'chip.premium': 'Coinbase premium',
      'chip.cme_gap': 'CME gap',
      'chip.liquidations': 'Liquidations',
      'chip.mute': 'silent source',

      'ticket.buy': 'Buy',
      'ticket.sell': 'Sell',
      'ticket.qty': 'Quantity',
      'ticket.stop': 'Stop',
      'ticket.target': 'Target',
      'ticket.confirm': 'Confirm',
      'ticket.confirm_anyway': 'Send anyway',
      'ticket.cancel': 'Cancel',
      'ticket.sent': 'Order sent.',
      'ticket.error': 'Order refused: {error}',
      'ticket.needs_confirm': 'The server warns: {codes}',
      'ticket.fees': 'Round-trip fees',
      'ticket.risk': 'Risk',
      'ticket.r_multiple': 'R',
      'ticket.move_to_beat': 'Move to beat',
      'ticket.locked': 'Ticket locked.',
      'ticket.computing': 'Computing...',

      'scalp.open': 'Open the scalp',
      'scalp.close': 'Exit',
      'scalp.running': 'Scalp open for {duration}',
      'scalp.result': 'Result',
      'scalp.queued': 'Scalp kept in the local queue (Omen unreachable).',
      'scalp.sent': 'Scalp recorded.',
      'scalp.mae': 'Worst drawdown',
      'scalp.mfe': 'Best excursion',
      'scalp.no_profile': 'Pick a fee profile before opening a scalp.',
      'scalp.size_auto': 'Auto size: {qty} ≈ {notional} CHF · round-trip fees ≈ {fees} CHF',
      'scalp.size_none': 'Not enough capital for one unit at this price: scalp refused.',

      'guard.all_clear': 'Nothing stands against this scalp.',
      'guard.event_risk': 'Macro event imminent — stay out.',
      'guard.funding_soon': 'Funding settles in under 5 minutes.',
      'guard.flash_news': 'News published under 2 minutes ago.',
      'guard.vol_spike': '1-minute volatility at twice its median.',
      'guard.spread_wide': 'Bid/ask spread at twice its median.',
      'guard.fee_coverage': 'This scalp must gain {required_pct} % to pay the broker.',
      'guard.cooldown': 'Last losing scalp under 10 minutes ago.',
      'guard.pace': 'More than 6 scalps in the hour.',
      'guard.daily_loss': 'Daily loss past 2 % — stop for today.',

      'warn.no_stop': 'No stop.',
      'warn.oversized': 'Position too large.',
      'warn.fee_ratio': 'Fees heavy against the intended gain.',
      'warn.stop_in_noise': 'Stop inside the noise.',
      'warn.concentration': 'High concentration.',
      'warn.revenge_trade': 'Revenge trade.',
      'warn.overtrading': 'Too many trades.',
      'warn.cash_floor': 'Cash floor reached.',

      'draw.levels': 'Draw the levels',
      'draw.bets': 'Draw the bets',
      'draw.clear': 'Clear',
      'draw.done': '{n} drawings placed.',
      'draw.no_bets': 'The coach has no open bet on this symbol: nothing to draw.',
      'draw.no_levels': 'No level to draw: open a ticket or a position first.',

      'section.watchlist': 'Watchlist',
      'watchlist.import': 'Import watchlist',
      'watchlist.hint': 'One way only: TradingView into your OmenServer favourites.',
      'watchlist.reading': 'Reading the TradingView watchlist...',
      'watchlist.not_found': 'TradingView watchlist not found on this page.',
      'watchlist.empty': 'No symbol in the displayed watchlist.',
      'watchlist.importing': 'Importing ({done}/{total})...',
      'watchlist.done': '{added} imported, {skipped} skipped, {unknown} unknown.',
      'watchlist.unknown_list': 'Unknown: {list}',
      'watchlist.capped': 'Import capped at {cap} symbols.',
      'watchlist.failed': 'Import stopped: {error}',

      'alert.title': 'New alert',
      'alert.price': 'Level',
      'alert.op_above': 'Above',
      'alert.op_below': 'Below',
      'alert.create': 'Create',
      'alert.cancel': 'Cancel',
      'alert.created': 'Alert set: {condition}.',
      'alert.error': 'Alert refused: {error}',
      'alert.already_true': 'That level is already crossed: the server will refuse.',
      'alert.hint': 'Alt+click the chart to set an alert at that level.',
      'alert.no_symbol': 'Symbol not tracked: no alert possible.',

      'note.title': 'Quick note',
      'note.placeholder': 'One line for the idea journal...',
      'note.send': 'Note it',
      'note.sent': 'Noted.',
      'note.error': 'Note refused: {error}',
      'note.hint': 'Ctrl+Enter sends ({left} characters left).',

      'review.auto_pending': 'Automatic review running (20 min without a scalp)...',
      'review.auto_done': 'Automatic review after 20 minutes without a scalp.',
      'review.capped': 'Review cap reached: nothing before tomorrow.',

      'ads.closed': 'Ads closed: {n}',

      'options.title': 'Coach options',
      'options.fee_profile': 'Fee profile',
      'options.fee_profile_hint': 'Without a profile the ticket refuses to open a scalp.',
      'options.custom_pct': 'Custom fees (% per side)',
      'options.risk_pct': 'Risk per trade (%)',
      'options.lang': 'Language',
      'options.scalp_auto': 'Automatic scalp mode under 5 min',
      'options.ads_auto_close': 'Auto-close TradingView ads (bottom-left corner and the “ad-free” pop-up)',
      'options.api_base': 'Omen URL',
      'options.token': 'Token (manual paste)',
      'options.token_hint': 'The "Connect" button on omenserver.org fills it in for you. Leave empty to keep the current token.',
      'options.save': 'Save',
      'options.saved': 'Saved.',
      'options.reload': 'Reload the extension',
      'options.reload_hint': 'After the extension files were updated (same as ↻ in chrome://extensions). Then reload the TradingView tab.',
      'options.choose_fee_profile': 'Pick your fee profile to get started.',
      'options.connected': 'Extension connected to {base}.'
    }
  };

  /** Langue reconnue, sinon ``fr`` (jamais une langue inventée). */
  function normalizeLang(lang) {
    var cleaned = String(lang || '').trim().toLowerCase().slice(0, 2);
    return LANGS.indexOf(cleaned) === -1 ? DEFAULT_LANG : cleaned;
  }

  /** Remplace ``{clef}`` par la valeur fournie ; une clef absente reste telle quelle. */
  function interpolate(text, values) {
    if (!values || typeof values !== 'object') { return text; }
    return String(text).replace(/\{([a-z0-9_]+)\}/gi, function (whole, name) {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        var value = values[name];
        return value === null || value === undefined ? '' : String(value);
      }
      return whole;
    });
  }

  /**
   * ``t('panel.title', 'it') -> 'Coach OmenServer'``.
   * Clé inconnue -> la clé (une chaîne manquante doit SE VOIR).
   */
  function t(key, lang, values) {
    var dict = STRINGS[normalizeLang(lang)] || STRINGS[DEFAULT_LANG];
    var name = String(key || '');
    var text = Object.prototype.hasOwnProperty.call(dict, name) ? dict[name] : null;
    if (text === null) {
      var fallback = STRINGS[DEFAULT_LANG];
      text = Object.prototype.hasOwnProperty.call(fallback, name) ? fallback[name] : name;
    }
    return interpolate(text, values);
  }

  /** ``maker('it')`` rend un ``t(key, values)`` déjà lié à la langue. */
  function maker(lang) {
    var fixed = normalizeLang(lang);
    return function (key, values) { return t(key, fixed, values); };
  }

  var api = {
    t: t,
    maker: maker,
    normalizeLang: normalizeLang,
    interpolate: interpolate,
    LANGS: LANGS,
    DEFAULT_LANG: DEFAULT_LANG,
    STRINGS: STRINGS
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.i18n = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
