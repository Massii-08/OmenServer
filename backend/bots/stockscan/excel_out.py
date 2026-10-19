"""Le classeur Excel du scanner — UN lecteur de ``results.json``, rien de plus.

MÊME PRÉSENTATION QUE LE BOND SCANNER (demande Massii du 19/10 : « le action
scanner doit donner des excel comme le bond scanner ») : UNE FEUILLE PAR
MARCHÉ comme le Bond Scanner en fait une par devise, le nom du marché en titre
au-dessus du tableau, l'en-tête bleu, une première colonne « PAPY » vide pour
cocher à la main, les lignes à surveiller en rouge, le fichier nommé
``Opportunita_Azioni_<date>.xlsx`` comme ``Opportunita_Bond_<date>.xlsx``. Une
dernière feuille « Infos » garde les critères, compteurs, avertissements et
sources du relevé.

Les pourcentages sont rangés tels que publiés (2,31 = 2,31 %) avec un ``%``
littéral dans le format — jamais le format natif ``0.00%`` qui multiplierait
par cent. Toute chaîne passe par ``_safe_text`` (injection de formule).
"""
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from backend.bots.stockscan import markets as mk

# --- Styles (miroir Bond Scanner / Market Pulse) ----------------------------
HEADER_FILL = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")
HEADER_FONT = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
TITLE_FONT = Font(name="Calibri", size=14, bold=True, color="2F5496")
SUBTITLE_FONT = Font(name="Calibri", size=12, bold=True, color="2F5496")
WARNING_FONT = Font(name="Calibri", size=10, bold=True, italic=True, color="C00000")
DATA_FONT = Font(name="Calibri", size=10, color="000000")
GREEN_FONT = Font(name="Calibri", size=10, color="107C10")
RED_FONT = Font(name="Calibri", size=10, color="FF0000")
LINK_FONT = Font(name="Calibri", size=10, color="0563C1", underline="single")
CENTER = Alignment(horizontal="center", vertical="center")
LEFT = Alignment(horizontal="left", vertical="center")
WRAP = Alignment(horizontal="left", vertical="center", wrap_text=True)
THIN_BORDER = Border(left=Side(style="thin", color="D9D9D9"),
                     right=Side(style="thin", color="D9D9D9"),
                     top=Side(style="thin", color="D9D9D9"),
                     bottom=Side(style="thin", color="D9D9D9"))

FMT_NUM = "#,##0.00"
FMT_PCT = '+0.00"%";-0.00"%";0.00"%"'
FMT_RATIO = '0.0"×"'
FMT_INT = "#,##0"
FMT_ONE = "#,##0.0"
FMT_DATE = "DD/MM/YYYY"

NOTE_FONT = Font(name="Calibri", size=9, italic=True, color="7F7F7F")

# Comme le Bond Scanner : ligne 1 (note), ligne 2 = titre, ligne 3 = en-tête.
HEADER_ROW = 3
DATA_START_ROW = 4

LABELS: Dict[str, Dict[str, Any]] = {
    "fr": {
        "file": "Opportunites_Actions",
        "sheet": "Candidats", "info_sheet": "Infos",
        "name_header": "{date} Actions (Scanner d'actions)",
        "price_header": "Cours - {cur}",
        "title": "Scanner d'actions — candidats à étudier",
        "disclaimer": ("Outil d'étude, pas un conseil d'investissement. "
                       "Données différées d'environ 15 minutes."),
        "summary": ("Univers : {universe} titres · présélection : {shortlist} · retenus : {kept}"
                    " · exclus : {no_cat} sans catalyseur, {red} en rouge"),
        "headers": ["PAPY", "{name}", "Titre", "{price}", "Var. jour", "Vol. relatif",
                    "Score", "Alertes", "Pourquoi", "News principale", "Résultats",
                    "Séance", "Graphique"],
        "chart": "TradingView",
        "reasons": {
            "news": "{v} news en {h} h", "sources": "{v} sources distinctes",
            "positive": "bonne nouvelle", "upcoming": "catalyseur annoncé",
            "earnings": "résultats le {v}", "volume": "volume ×{v} vs son marché",
            "aligned": "le cours confirme ({v} %)", "coach_up": "hypothèse du coach : hausse",
            "crowd": "buzz Reddit ({v} mentions)", "filing": "dépôt SEC {v}",
            "awaiting_open": "news après la dernière clôture : pas encore dans le cours",
        },
        "flags": {
            "red": "news négative", "late": "déjà parti", "earnings_soon": "résultats proches",
            "coach_down": "coach : baisse", "crowd": "foule", "followed": "suivi",
            "new": "nouveau", "news_unverified": "news non vérifiées",
            "awaiting_open": "attend l'ouverture",
        },
        "warnings": {
            "coach_empty": "Carnet du coach vide (veille inactive ?)",
            "degraded_columns": "Colonnes du screener vides : {columns}",
            "market_failed": "Marché en échec : {market} ({error})",
            "fallback_universe": "Univers de repli (grandes valeurs) : le screener n'a rien rendu",
            "news_breaker": "Flux de news interrompu : les titres restants ne sont pas vérifiés",
            "stopped_early": "Relevé arrêté avant la fin",
            "fallback_failed": "Repli abandonné : Yahoo ne répond pas non plus",
            "excel_failed": "Classeur Excel non produit",
        },
        "session": {
            "open": "en séance ({p} %)", "closed": "fermée", "unknown": "inconnue",
        },
        "info": {
            "criteria": "Critères", "counts": "Compteurs", "markets": "Marchés",
            "warnings": "Avertissements", "sources": "Sources", "generated": "Généré le",
            "none": "aucun",
            "keys": {"markets": "Marchés", "min_cap_meur": "Capitalisation min. (M€)",
                     "min_value_meur": "Échanges moyens min. (M€/jour)",
                     "window_h": "Fenêtre des news (h)", "top_n": "Lignes rendues",
                     "shortlist": "Présélection", "exclude_red": "Exclure les titres en rouge"},
            "yes": "oui", "no": "non", "ok": "ok", "failed": "échec : {error}",
            "count_names": {
                "universe": "Univers", "shortlist": "Présélection",
                "news_requests": "Requêtes de news", "news_failed": "Requêtes en échec",
                "news_from_cache": "News lues dans le cache du coach",
                "candidates": "Candidats", "kept": "Retenus",
                "excluded_no_catalyst": "Sans catalyseur",
                "excluded_red": "Exclus (news négative)",
                "filtered_advice": "Titres-conseils écartés",
                "dropped_irrelevant": "News hors sujet", "coach_events": "Événements du coach",
            },
            "source_lines": ["Univers : screener public TradingView (différé ~15 min)",
                             "News : collecteur TradingView du coach + carnets du coach",
                             "Aucun LLM : classement déterministe, raisons affichées"],
        },
    },
    "en": {
        "file": "Stock_Opportunities",
        "sheet": "Candidates", "info_sheet": "Info",
        "name_header": "{date} Stocks (Stock scanner)",
        "price_header": "Price - {cur}",
        "title": "Stock scanner — candidates to study",
        "disclaimer": "Study tool, not investment advice. Data delayed by about 15 minutes.",
        "summary": ("Universe: {universe} stocks · shortlist: {shortlist} · kept: {kept}"
                    " · excluded: {no_cat} without catalyst, {red} flagged red"),
        "headers": ["PAPY", "{name}", "Ticker", "{price}", "Day chg", "Rel. volume",
                    "Score", "Alerts", "Why", "Top news", "Earnings", "Session", "Chart"],
        "chart": "TradingView",
        "reasons": {
            "news": "{v} news in {h} h", "sources": "{v} distinct sources",
            "positive": "good news", "upcoming": "announced catalyst",
            "earnings": "earnings on {v}", "volume": "volume ×{v} vs its market",
            "aligned": "price confirms ({v} %)", "coach_up": "coach hypothesis: up",
            "crowd": "Reddit buzz ({v} mentions)", "filing": "SEC filing {v}",
            "awaiting_open": "news after the last close: not in the price yet",
        },
        "flags": {
            "red": "negative news", "late": "already moved", "earnings_soon": "earnings soon",
            "coach_down": "coach: down", "crowd": "crowd", "followed": "followed",
            "new": "new", "news_unverified": "news not checked",
            "awaiting_open": "awaiting the open",
        },
        "warnings": {
            "coach_empty": "Coach notebook empty (news watch inactive?)",
            "degraded_columns": "Empty screener columns: {columns}",
            "market_failed": "Market failed: {market} ({error})",
            "fallback_universe": "Fallback universe (large caps): the screener returned nothing",
            "news_breaker": "News feed interrupted: remaining stocks were not checked",
            "stopped_early": "Scan stopped before the end",
            "fallback_failed": "Fallback abandoned: Yahoo is not answering either",
            "excel_failed": "Excel workbook not produced",
        },
        "session": {
            "open": "in session ({p}%)", "closed": "closed", "unknown": "unknown",
        },
        "info": {
            "criteria": "Criteria", "counts": "Counts", "markets": "Markets",
            "warnings": "Warnings", "sources": "Sources", "generated": "Generated at",
            "none": "none",
            "keys": {"markets": "Markets", "min_cap_meur": "Min. market cap (M€)",
                     "min_value_meur": "Min. avg traded value (M€/day)",
                     "window_h": "News window (h)", "top_n": "Rows returned",
                     "shortlist": "Shortlist", "exclude_red": "Exclude red-flagged stocks"},
            "yes": "yes", "no": "no", "ok": "ok", "failed": "failed: {error}",
            "count_names": {
                "universe": "Universe", "shortlist": "Shortlist",
                "news_requests": "News requests", "news_failed": "Failed requests",
                "news_from_cache": "News read from the coach's cache",
                "candidates": "Candidates", "kept": "Kept",
                "excluded_no_catalyst": "No catalyst",
                "excluded_red": "Excluded (negative news)",
                "filtered_advice": "Advice headlines dropped",
                "dropped_irrelevant": "Off-topic news", "coach_events": "Coach events",
            },
            "source_lines": ["Universe: TradingView public screener (delayed ~15 min)",
                             "News: the coach's TradingView collector + coach notebooks",
                             "No LLM: deterministic ranking, reasons shown"],
        },
    },
    "it": {
        "file": "Opportunita_Azioni",
        "sheet": "Candidati", "info_sheet": "Info",
        "name_header": "{date} Azioni (Scanner azioni)",
        "price_header": "Prezzo - {cur}",
        "title": "Scanner azioni — candidati da studiare",
        "disclaimer": ("Strumento di studio, non un consiglio di investimento. "
                       "Dati ritardati di circa 15 minuti."),
        "summary": ("Universo: {universe} titoli · preselezione: {shortlist} · tenuti: {kept}"
                    " · esclusi: {no_cat} senza catalizzatore, {red} in rosso"),
        "headers": ["PAPY", "{name}", "Titolo", "{price}", "Var. giorno", "Vol. relativo",
                    "Punteggio", "Avvisi", "Perché", "Notizia principale", "Risultati",
                    "Seduta", "Grafico"],
        "chart": "TradingView",
        "reasons": {
            "news": "{v} notizie in {h} h", "sources": "{v} fonti distinte",
            "positive": "buona notizia", "upcoming": "catalizzatore annunciato",
            "earnings": "risultati il {v}", "volume": "volume ×{v} rispetto al suo mercato",
            "aligned": "il prezzo conferma ({v} %)", "coach_up": "ipotesi del coach: rialzo",
            "crowd": "buzz Reddit ({v} menzioni)", "filing": "deposito SEC {v}",
            "awaiting_open": "notizia dopo l'ultima chiusura: non ancora nel prezzo",
        },
        "flags": {
            "red": "notizia negativa", "late": "già partito", "earnings_soon": "risultati vicini",
            "coach_down": "coach: ribasso", "crowd": "folla", "followed": "seguito",
            "new": "nuovo", "news_unverified": "notizie non verificate",
            "awaiting_open": "in attesa dell'apertura",
        },
        "warnings": {
            "coach_empty": "Taccuino del coach vuoto (sorveglianza inattiva?)",
            "degraded_columns": "Colonne dello screener vuote: {columns}",
            "market_failed": "Mercato in errore: {market} ({error})",
            "fallback_universe": "Universo di riserva (grandi titoli): lo screener non ha reso nulla",
            "news_breaker": "Flusso di notizie interrotto: i titoli restanti non sono verificati",
            "stopped_early": "Scansione interrotta prima della fine",
            "fallback_failed": "Riserva abbandonata: nemmeno Yahoo risponde",
            "excel_failed": "Cartella Excel non prodotta",
        },
        "session": {
            "open": "in seduta ({p} %)", "closed": "chiusa", "unknown": "sconosciuta",
        },
        "info": {
            "criteria": "Criteri", "counts": "Contatori", "markets": "Mercati",
            "warnings": "Avvisi", "sources": "Fonti", "generated": "Generato il",
            "none": "nessuno",
            "keys": {"markets": "Mercati", "min_cap_meur": "Capitalizzazione min. (M€)",
                     "min_value_meur": "Scambi medi min. (M€/giorno)",
                     "window_h": "Finestra notizie (h)", "top_n": "Righe restituite",
                     "shortlist": "Preselezione", "exclude_red": "Escludere i titoli in rosso"},
            "yes": "sì", "no": "no", "ok": "ok", "failed": "errore: {error}",
            "count_names": {
                "universe": "Universo", "shortlist": "Preselezione",
                "news_requests": "Richieste di notizie", "news_failed": "Richieste fallite",
                "news_from_cache": "Notizie dalla cache del coach",
                "candidates": "Candidati", "kept": "Selezionati",
                "excluded_no_catalyst": "Senza catalizzatore",
                "excluded_red": "Esclusi (notizia negativa)",
                "filtered_advice": "Titoli-consiglio scartati",
                "dropped_irrelevant": "Notizie fuori tema", "coach_events": "Eventi del coach",
            },
            "source_lines": ["Universo: screener pubblico TradingView (ritardato ~15 min)",
                             "Notizie: collettore TradingView del coach + taccuini del coach",
                             "Nessun LLM: classifica deterministica, motivi mostrati"],
        },
    },
}

# A PAPY · B nom · C titre · D cours · E var. · F vol. · G score · H alertes ·
# I pourquoi · J news · K résultats · L séance · M graphique
WIDTHS = [7, 40, 10, 14, 11, 11, 9, 24, 46, 52, 12, 16, 12]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def labels(lang: Any) -> Dict[str, Any]:
    return LABELS.get(lang) if lang in LABELS else LABELS["it"]


def _safe_text(value: Any) -> Optional[str]:
    """Neutralise l'injection de formule (= + - @ tab CR en tête -> apostrophe)."""
    if value is None:
        return None
    text = value if isinstance(value, str) else str(value)
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


def _num(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return None if out != out else out


def _date(value: Any) -> Optional[date]:
    if isinstance(value, str) and len(value) >= 10:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _http(url: Any) -> Optional[str]:
    if isinstance(url, str) and url.startswith(("http://", "https://")):
        return url
    return None


def _fmt_value(value: Any, lang: str) -> str:
    """Valeur d'une raison -> texte (dates à la française/italienne)."""
    day = _date(value) if isinstance(value, str) else None
    if day is not None:
        return day.isoformat() if lang == "en" else day.strftime("%d/%m/%Y")
    if isinstance(value, float):
        text = ("%.2f" % value).rstrip("0").rstrip(".")
        return text if lang == "en" else text.replace(".", ",")
    return "" if value is None else str(value)


def reason_text(reason: Dict[str, Any], lang: str) -> str:
    tpl = labels(lang)["reasons"].get(reason.get("code"))
    if not tpl:
        return str(reason.get("code") or "")
    return tpl.replace("{v}", _fmt_value(reason.get("value"), lang)) \
              .replace("{h}", str(reason.get("hours") or ""))


def session_text(session: Any, lang: str) -> Optional[str]:
    """État de la bourse au moment du scan : « en séance (74 %) » / « fermée »."""
    if not isinstance(session, dict):
        return None
    lab = labels(lang)["session"]
    state = session.get("state") if session.get("state") in lab else "unknown"
    elapsed = _num(session.get("elapsed"))
    pct = str(int(round(elapsed * 100))) if elapsed is not None else "?"
    return lab[state].replace("{p}", pct)


def flag_text(flag: str, lang: str) -> str:
    return labels(lang)["flags"].get(flag, flag)


def warning_text(warning: Dict[str, Any], lang: str) -> str:
    tpl = labels(lang)["warnings"].get(warning.get("code"))
    if not tpl:
        return str(warning.get("code") or "")
    # Les marchés par leur NOM dans la langue du classeur (« Svizzera »), pas
    # par leur identifiant technique (« switzerland ») ; un identifiant inconnu
    # reste affiché tel quel.
    market = warning.get("market")
    return tpl.replace("{columns}", ", ".join(warning.get("columns") or [])) \
              .replace("{market}", _market_name(market, lang, short=True) if market else "") \
              .replace("{error}", str(warning.get("error") or "")) \
              .replace("{markets}", ", ".join(_market_name(m, lang, short=True)
                                              for m in warning.get("markets") or []))


def _put(ws, row: int, col: int, value: Any = None, font: Font = DATA_FONT,
         fmt: Optional[str] = None, align: Alignment = CENTER,
         link: Optional[str] = None):
    cell = ws.cell(row=row, column=col)
    if value is not None:
        cell.value = _safe_text(value) if isinstance(value, str) else value
    cell.font = font
    cell.alignment = align
    cell.border = THIN_BORDER
    if fmt and value is not None:
        cell.number_format = fmt
    if link:
        cell.hyperlink = link
        cell.font = LINK_FONT
    return cell


def _sign_font(value: Optional[float]) -> Font:
    if value is None or value == 0:
        return DATA_FONT
    return GREEN_FONT if value > 0 else RED_FONT


def file_name(results: Dict[str, Any], lang: str) -> str:
    stamp = str(results.get("generated_at") or "")[:10] or datetime.now().strftime("%Y-%m-%d")
    return "%s_%s.xlsx" % (labels(lang)["file"], stamp)


# --------------------------------------------------------------------------- #
# Feuilles
# --------------------------------------------------------------------------- #

def _market_name(market_id: Any, lang: str, short: bool = False) -> str:
    """« Italie (Borsa Italiana) » ; en version courte (onglet) : « Italie »."""
    market = mk.by_id(market_id)
    if market is None:
        return str(market_id or "?")
    label = market.labels.get(lang, market.labels["fr"])
    return label.split(" (")[0] if short else label


def _sheet_title(name: str, taken: List[str]) -> str:
    """Nom d'onglet valide (31 caractères, sans []:*?/\\) et unique."""
    clean = "".join("-" if ch in '[]:*?/\\' else ch for ch in name).strip()[:31] or "?"
    title, n = clean, 2
    while title.lower() in (t.lower() for t in taken):
        suffix = " (%d)" % n
        title = clean[:31 - len(suffix)] + suffix
        n += 1
    return title


def _sheet_currency(rows: List[Dict[str, Any]], market_id: Any) -> str:
    """La devise de l'en-tête « Cours - EUR » : la plus fréquente des lignes,
    sinon celle du marché (comme le Bond Scanner, une devise par feuille)."""
    counts: Dict[str, int] = {}
    for row in rows:
        cur = str(row.get("currency") or "").strip()
        if cur:
            counts[cur] = counts.get(cur, 0) + 1
    if counts:
        return max(sorted(counts), key=lambda c: counts[c])
    market = mk.by_id(market_id)
    return market.currency if market else ""


def _market_sheet(ws, market_id: Any, rows: List[Dict[str, Any]],
                  results: Dict[str, Any], lang: str) -> None:
    """Une feuille par marché, présentée comme celles du Bond Scanner."""
    lab = labels(lang)
    for col, width in enumerate(WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(col)].width = width

    # Ligne 1 : le rappel « outil d'étude » (discret). Ligne 2 : le titre.
    ws.cell(row=1, column=2, value=lab["disclaimer"]).font = NOTE_FONT
    ws.merge_cells(start_row=2, start_column=3, end_row=2, end_column=7)
    title = ws.cell(row=2, column=3, value=_safe_text(_market_name(market_id, lang)))
    title.font, title.alignment = TITLE_FONT, CENTER

    # Ligne 3 : l'en-tête bleu (« 19.10.26 Azioni (Scanner azioni) », « Prezzo - EUR »).
    stamp = _date(results.get("generated_at"))
    currency = _sheet_currency(rows, market_id)
    for col, header in enumerate(lab["headers"], start=1):
        text = header.replace("{name}", lab["name_header"].replace(
            "{date}", stamp.strftime("%d.%m.%y") if stamp else "")).strip()
        text = text.replace("{price}", lab["price_header"].replace("{cur}", currency)).strip(" -")
        cell = ws.cell(row=HEADER_ROW, column=col, value=text)
        cell.font, cell.fill, cell.alignment, cell.border = HEADER_FONT, HEADER_FILL, CENTER, THIN_BORDER

    row_idx = DATA_START_ROW
    for row in rows:
        news = [n for n in row.get("news") or [] if isinstance(n, dict)]
        top = news[0] if news else {}
        flags = [f for f in row.get("flags") or [] if isinstance(f, str)]
        # Comme le prix trop cher du Bond Scanner : une ligne à surveiller
        # (mauvaise nouvelle) s'écrit en rouge d'un bout à l'autre.
        font = RED_FONT if "red" in flags else DATA_FONT
        change = _num(row.get("change_pct"))
        price = _num(row.get("price"))
        row_currency = str(row.get("currency") or "")
        price_fmt = FMT_NUM if not row_currency or row_currency == currency \
            else FMT_NUM + ' "%s"' % row_currency.replace('"', "")
        _put(ws, row_idx, 1)                                           # PAPY : à la main
        _put(ws, row_idx, 2, row.get("name") or row.get("ticker"), font=font, align=LEFT)
        _put(ws, row_idx, 3, row.get("ticker") or row.get("tv_symbol"), font=font)
        _put(ws, row_idx, 4, price, font=font, fmt=price_fmt)
        _put(ws, row_idx, 5, change, font=font if "red" in flags else _sign_font(change), fmt=FMT_PCT)
        _put(ws, row_idx, 6, _num(row.get("rel_volume")), font=font, fmt=FMT_RATIO)
        _put(ws, row_idx, 7, _num(row.get("score")), font=font, fmt=FMT_INT)
        _put(ws, row_idx, 8, ", ".join(flag_text(f, lang) for f in flags) or None,
             font=font, align=WRAP)
        _put(ws, row_idx, 9, " · ".join(reason_text(r, lang) for r in row.get("reasons") or []
                                        if isinstance(r, dict)) or None, font=font, align=WRAP)
        _put(ws, row_idx, 10, top.get("title"), font=font, align=WRAP, link=_http(top.get("url")))
        _put(ws, row_idx, 11, _date(row.get("earnings_next")), font=font, fmt=FMT_DATE)
        _put(ws, row_idx, 12, session_text(row.get("session"), lang), font=font, align=LEFT)
        chart = _http((row.get("links") or {}).get("chart"))
        _put(ws, row_idx, 13, lab["chart"] if chart else None, link=chart)
        row_idx += 1

    ws.freeze_panes = "A%d" % DATA_START_ROW
    last_col = get_column_letter(len(lab["headers"]))
    ws.auto_filter.ref = "A%d:%s%d" % (HEADER_ROW, last_col, max(HEADER_ROW, row_idx - 1))
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True


def _stamp_text(value: Any, lang: str) -> str:
    """« 17/10/2026 07:45 UTC » (anglais : « 2026-10-17 07:45 UTC ») — jamais
    l'ISO brut avec ses secondes et son fuseau."""
    if not isinstance(value, str) or not value:
        return ""
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return moment.strftime("%Y-%m-%d %H:%M UTC" if lang == "en" else "%d/%m/%Y %H:%M UTC")


def _info_sheet(ws, results: Dict[str, Any], lang: str) -> None:
    lab = labels(lang)
    info = lab["info"]
    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 70
    # Imprimée, la feuille tient sur la largeur d'une page (comme celles des
    # marchés) : sinon la colonne B part seule sur une seconde page.
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    r = 1
    ws.cell(row=r, column=1, value=lab["title"]).font = TITLE_FONT
    r += 1
    ws.cell(row=r, column=1, value=info["generated"]).font = DATA_FONT
    ws.cell(row=r, column=2, value=_safe_text(_stamp_text(results.get("generated_at"), lang))).font = DATA_FONT
    r += 1
    counts = results.get("counts") or {}
    ws.cell(row=r, column=1, value=lab["summary"].format(
        universe=counts.get("universe", 0), shortlist=counts.get("shortlist", 0),
        kept=counts.get("kept", 0), no_cat=counts.get("excluded_no_catalyst", 0),
        red=counts.get("excluded_red", 0))).font = DATA_FONT
    r += 2

    cfg = results.get("config") or {}
    ws.cell(row=r, column=1, value=info["criteria"]).font = SUBTITLE_FONT
    r += 1
    for key, label in info["keys"].items():
        value = cfg.get(key)
        if key == "markets":
            names = []
            for mid in value or []:
                m = mk.by_id(mid)
                names.append(m.labels.get(lang, m.labels["fr"]) if m else str(mid))
            value = ", ".join(names)
        elif isinstance(value, bool):
            value = info["yes"] if value else info["no"]
        ws.cell(row=r, column=1, value=label).font = DATA_FONT
        ws.cell(row=r, column=2, value=_safe_text(value) if isinstance(value, str) else value).font = DATA_FONT
        r += 1
    r += 1

    ws.cell(row=r, column=1, value=info["counts"]).font = SUBTITLE_FONT
    r += 1
    for key, value in (results.get("counts") or {}).items():
        # Un compteur sans libellé (ajouté plus tard) garde sa clé : jamais perdu.
        name = info["count_names"].get(key, key)
        ws.cell(row=r, column=1, value=_safe_text(str(name))).font = DATA_FONT
        ws.cell(row=r, column=2, value=value).font = DATA_FONT
        r += 1
    r += 1

    ws.cell(row=r, column=1, value=info["markets"]).font = SUBTITLE_FONT
    r += 1
    for m in results.get("markets") or []:
        if not isinstance(m, dict):
            continue
        market = mk.by_id(m.get("id"))
        name = market.labels.get(lang, market.labels["fr"]) if market else str(m.get("id"))
        state = ("%s (%s)" % (info["ok"], m.get("rows"))) if m.get("ok") else \
            info["failed"].replace("{error}", str(m.get("error") or ""))
        ws.cell(row=r, column=1, value=_safe_text(name)).font = DATA_FONT
        ws.cell(row=r, column=2, value=_safe_text(state)).font = DATA_FONT if m.get("ok") else RED_FONT
        r += 1
    r += 1

    ws.cell(row=r, column=1, value=info["warnings"]).font = SUBTITLE_FONT
    r += 1
    warnings = [w for w in results.get("warnings") or [] if isinstance(w, dict)]
    if not warnings:
        ws.cell(row=r, column=1, value=info["none"]).font = DATA_FONT
        r += 1
    for w in warnings:
        ws.cell(row=r, column=1, value=_safe_text(warning_text(w, lang))).font = WARNING_FONT
        r += 1
    r += 1

    ws.cell(row=r, column=1, value=info["sources"]).font = SUBTITLE_FONT
    r += 1
    for line in info["source_lines"]:
        ws.cell(row=r, column=1, value=line).font = DATA_FONT
        r += 1
    ws.cell(row=r + 1, column=1, value=lab["disclaimer"]).font = WARNING_FONT


def write_workbook(results: Dict[str, Any], out_dir: Any, lang: Optional[str] = None) -> Path:
    """Écrit le classeur dans ``out_dir`` et rend son chemin.

    Une feuille par marché demandé (même vide, comme les feuilles Euro/USD/GBP
    du Bond Scanner), dans l'ordre des réglages, lignes dans l'ordre du
    classement ; puis la feuille « Infos ».
    """
    lang = lang or (results.get("config") or {}).get("lang") or "it"
    if lang not in LABELS:
        lang = "it"
    rows = [r for r in results.get("rows") or [] if isinstance(r, dict)]
    markets: List[Any] = list((results.get("config") or {}).get("markets") or [])
    for row in rows:                                   # un marché hors réglages (repli)
        if row.get("market") not in markets:
            markets.append(row.get("market"))

    wb = Workbook()
    wb.remove(wb.active)
    taken: List[str] = []
    for market_id in markets:
        title = _sheet_title(_market_name(market_id, lang, short=True), taken)
        taken.append(title)
        _market_sheet(wb.create_sheet(title), market_id,
                      [r for r in rows if r.get("market") == market_id], results, lang)
    if not markets:
        _market_sheet(wb.create_sheet(labels(lang)["sheet"]), None, [], results, lang)
    _info_sheet(wb.create_sheet(_sheet_title(labels(lang)["info_sheet"], taken)), results, lang)
    wb.properties.creator = "Scanner d'actions — OmenServer"
    path = Path(out_dir) / file_name(results, lang)
    tmp = path.with_name("." + path.name + ".tmp")
    wb.save(str(tmp))
    tmp.replace(path)
    return path
