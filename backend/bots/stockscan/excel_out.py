"""Le classeur Excel du scanner — UN lecteur de ``results.json``, rien de plus.

Styles et formats repris du Bond Scanner et de Market Pulse (même famille de
bots, même rendu). Deux feuilles : les candidats classés, puis les infos du
relevé (critères, compteurs, avertissements, sources).

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

DATA_START_ROW = 6

LABELS: Dict[str, Dict[str, Any]] = {
    "fr": {
        "file": "scanner_actions",
        "sheet": "Candidats", "info_sheet": "Infos",
        "title": "Scanner d'actions — candidats à étudier",
        "disclaimer": ("Outil d'étude, pas un conseil d'investissement. "
                       "Données différées d'environ 15 minutes."),
        "summary": ("Univers : {universe} titres · présélection : {shortlist} · retenus : {kept}"
                    " · exclus : {no_cat} sans catalyseur, {red} en rouge"),
        "headers": ["Rang", "Titre", "Nom", "Marché", "Cours", "Devise", "Var. jour",
                    "Vol. relatif", "Score", "Signaux", "Raisons", "News principale",
                    "Nb news", "Résultats", "Capitalisation (M€)", "Échanges moy. (M€)",
                    "Graphique"],
        "chart": "TradingView",
        "reasons": {
            "news": "{v} news en {h} h", "sources": "{v} sources distinctes",
            "positive": "bonne nouvelle", "upcoming": "catalyseur annoncé",
            "earnings": "résultats le {v}", "volume": "volume ×{v} vs son marché",
            "aligned": "le cours confirme ({v} %)", "coach_up": "hypothèse du coach : hausse",
            "crowd": "buzz Reddit ({v} mentions)", "filing": "dépôt SEC {v}",
        },
        "flags": {
            "red": "news négative", "late": "déjà parti", "earnings_soon": "résultats proches",
            "coach_down": "coach : baisse", "crowd": "foule", "followed": "suivi",
            "new": "nouveau", "news_unverified": "news non vérifiées",
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
        "info": {
            "criteria": "Critères", "counts": "Compteurs", "markets": "Marchés",
            "warnings": "Avertissements", "sources": "Sources", "generated": "Généré le",
            "none": "aucun",
            "keys": {"markets": "Marchés", "min_cap_meur": "Capitalisation min. (M€)",
                     "min_value_meur": "Échanges moyens min. (M€/jour)",
                     "window_h": "Fenêtre des news (h)", "top_n": "Lignes rendues",
                     "shortlist": "Présélection", "exclude_red": "Exclure les titres en rouge"},
            "yes": "oui", "no": "non", "ok": "ok", "failed": "échec",
            "source_lines": ["Univers : screener public TradingView (différé ~15 min)",
                             "News : collecteur TradingView du coach + carnets du coach",
                             "Aucun LLM : classement déterministe, raisons affichées"],
        },
    },
    "en": {
        "file": "stock_scanner",
        "sheet": "Candidates", "info_sheet": "Info",
        "title": "Stock scanner — candidates to study",
        "disclaimer": "Study tool, not investment advice. Data delayed by about 15 minutes.",
        "summary": ("Universe: {universe} stocks · shortlist: {shortlist} · kept: {kept}"
                    " · excluded: {no_cat} without catalyst, {red} flagged red"),
        "headers": ["Rank", "Ticker", "Name", "Market", "Price", "Currency", "Day chg",
                    "Rel. volume", "Score", "Flags", "Reasons", "Top news", "News",
                    "Earnings", "Market cap (M€)", "Avg traded (M€)", "Chart"],
        "chart": "TradingView",
        "reasons": {
            "news": "{v} news in {h} h", "sources": "{v} distinct sources",
            "positive": "good news", "upcoming": "announced catalyst",
            "earnings": "earnings on {v}", "volume": "volume ×{v} vs its market",
            "aligned": "price confirms ({v} %)", "coach_up": "coach hypothesis: up",
            "crowd": "Reddit buzz ({v} mentions)", "filing": "SEC filing {v}",
        },
        "flags": {
            "red": "negative news", "late": "already moved", "earnings_soon": "earnings soon",
            "coach_down": "coach: down", "crowd": "crowd", "followed": "followed",
            "new": "new", "news_unverified": "news not checked",
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
        "info": {
            "criteria": "Criteria", "counts": "Counts", "markets": "Markets",
            "warnings": "Warnings", "sources": "Sources", "generated": "Generated at",
            "none": "none",
            "keys": {"markets": "Markets", "min_cap_meur": "Min. market cap (M€)",
                     "min_value_meur": "Min. avg traded value (M€/day)",
                     "window_h": "News window (h)", "top_n": "Rows returned",
                     "shortlist": "Shortlist", "exclude_red": "Exclude red-flagged stocks"},
            "yes": "yes", "no": "no", "ok": "ok", "failed": "failed",
            "source_lines": ["Universe: TradingView public screener (delayed ~15 min)",
                             "News: the coach's TradingView collector + coach notebooks",
                             "No LLM: deterministic ranking, reasons shown"],
        },
    },
    "it": {
        "file": "scanner_azioni",
        "sheet": "Candidati", "info_sheet": "Info",
        "title": "Scanner azioni — candidati da studiare",
        "disclaimer": ("Strumento di studio, non un consiglio di investimento. "
                       "Dati ritardati di circa 15 minuti."),
        "summary": ("Universo: {universe} titoli · preselezione: {shortlist} · tenuti: {kept}"
                    " · esclusi: {no_cat} senza catalizzatore, {red} in rosso"),
        "headers": ["Pos.", "Titolo", "Nome", "Mercato", "Prezzo", "Valuta", "Var. giorno",
                    "Vol. relativo", "Punteggio", "Segnali", "Motivi", "Notizia principale",
                    "N. notizie", "Risultati", "Capitalizzazione (M€)", "Scambi medi (M€)",
                    "Grafico"],
        "chart": "TradingView",
        "reasons": {
            "news": "{v} notizie in {h} h", "sources": "{v} fonti distinte",
            "positive": "buona notizia", "upcoming": "catalizzatore annunciato",
            "earnings": "risultati il {v}", "volume": "volume ×{v} rispetto al suo mercato",
            "aligned": "il prezzo conferma ({v} %)", "coach_up": "ipotesi del coach: rialzo",
            "crowd": "buzz Reddit ({v} menzioni)", "filing": "deposito SEC {v}",
        },
        "flags": {
            "red": "notizia negativa", "late": "già partito", "earnings_soon": "risultati vicini",
            "coach_down": "coach: ribasso", "crowd": "folla", "followed": "seguito",
            "new": "nuovo", "news_unverified": "notizie non verificate",
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
        "info": {
            "criteria": "Criteri", "counts": "Contatori", "markets": "Mercati",
            "warnings": "Avvisi", "sources": "Fonti", "generated": "Generato il",
            "none": "nessuno",
            "keys": {"markets": "Mercati", "min_cap_meur": "Capitalizzazione min. (M€)",
                     "min_value_meur": "Scambi medi min. (M€/giorno)",
                     "window_h": "Finestra notizie (h)", "top_n": "Righe restituite",
                     "shortlist": "Preselezione", "exclude_red": "Escludere i titoli in rosso"},
            "yes": "sì", "no": "no", "ok": "ok", "failed": "errore",
            "source_lines": ["Universo: screener pubblico TradingView (ritardato ~15 min)",
                             "Notizie: collettore TradingView del coach + taccuini del coach",
                             "Nessun LLM: classifica deterministica, motivi mostrati"],
        },
    },
}

WIDTHS = [6, 10, 30, 22, 11, 8, 10, 11, 8, 26, 46, 60, 8, 12, 17, 17, 13]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def labels(lang: Any) -> Dict[str, Any]:
    return LABELS.get(lang) if lang in LABELS else LABELS["fr"]


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


def flag_text(flag: str, lang: str) -> str:
    return labels(lang)["flags"].get(flag, flag)


def warning_text(warning: Dict[str, Any], lang: str) -> str:
    tpl = labels(lang)["warnings"].get(warning.get("code"))
    if not tpl:
        return str(warning.get("code") or "")
    return tpl.replace("{columns}", ", ".join(warning.get("columns") or [])) \
              .replace("{market}", str(warning.get("market") or "")) \
              .replace("{error}", str(warning.get("error") or ""))


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

def _candidates_sheet(ws, results: Dict[str, Any], lang: str) -> None:
    lab = labels(lang)
    counts = results.get("counts") or {}
    ws.title = lab["sheet"]
    stamp = str(results.get("generated_at") or "")[:16].replace("T", " ")
    ws.cell(row=1, column=1, value=_safe_text("%s — %s UTC" % (lab["title"], stamp))).font = TITLE_FONT
    ws.cell(row=2, column=1, value=lab["disclaimer"]).font = WARNING_FONT
    ws.cell(row=3, column=1, value=lab["summary"].format(
        universe=counts.get("universe", 0), shortlist=counts.get("shortlist", 0),
        kept=counts.get("kept", 0), no_cat=counts.get("excluded_no_catalyst", 0),
        red=counts.get("excluded_red", 0))).font = DATA_FONT

    header_row = DATA_START_ROW - 1
    for col, (title, width) in enumerate(zip(lab["headers"], WIDTHS), start=1):
        cell = ws.cell(row=header_row, column=col, value=title)
        cell.font, cell.fill, cell.alignment, cell.border = HEADER_FONT, HEADER_FILL, CENTER, THIN_BORDER
        ws.column_dimensions[get_column_letter(col)].width = width

    row_idx = DATA_START_ROW
    for row in results.get("rows") or []:
        if not isinstance(row, dict):
            continue
        news = [n for n in row.get("news") or [] if isinstance(n, dict)]
        top = news[0] if news else {}
        change = _num(row.get("change_pct"))
        # volume relatif « à l'heure » (comparable d'une place à l'autre), sinon le 10 j
        rel_volume = _num(row.get("rel_volume_time"))
        if rel_volume is None:
            rel_volume = _num(row.get("rel_volume"))
        market = mk.by_id(row.get("market"))
        market_label = market.labels.get(lang, market.labels["fr"]) if market else row.get("market")
        _put(ws, row_idx, 1, row.get("rank"), fmt=FMT_INT)
        _put(ws, row_idx, 2, row.get("ticker") or row.get("tv_symbol"), align=LEFT)
        _put(ws, row_idx, 3, row.get("name"), align=LEFT)
        _put(ws, row_idx, 4, market_label, align=LEFT)
        _put(ws, row_idx, 5, _num(row.get("price")), fmt=FMT_NUM)
        _put(ws, row_idx, 6, row.get("currency"))
        _put(ws, row_idx, 7, change, font=_sign_font(change), fmt=FMT_PCT)
        _put(ws, row_idx, 8, rel_volume, fmt=FMT_RATIO)
        _put(ws, row_idx, 9, _num(row.get("score")), fmt=FMT_INT)
        flags = [flag_text(f, lang) for f in row.get("flags") or []]
        _put(ws, row_idx, 10, ", ".join(flags) or None,
             font=RED_FONT if "red" in (row.get("flags") or []) else DATA_FONT, align=WRAP)
        _put(ws, row_idx, 11, " · ".join(reason_text(r, lang) for r in row.get("reasons") or [])
             or None, align=WRAP)
        _put(ws, row_idx, 12, top.get("title"), align=WRAP, link=_http(top.get("url")))
        _put(ws, row_idx, 13, len(news), fmt=FMT_INT)
        _put(ws, row_idx, 14, _date(row.get("earnings_next")), fmt=FMT_DATE)
        _put(ws, row_idx, 15, _num(row.get("market_cap_meur")), fmt=FMT_INT)
        _put(ws, row_idx, 16, _num(row.get("avg_value_meur")), fmt=FMT_ONE)
        chart = _http((row.get("links") or {}).get("chart"))
        _put(ws, row_idx, 17, lab["chart"] if chart else None, link=chart)
        row_idx += 1

    ws.freeze_panes = "A%d" % DATA_START_ROW
    last_col = get_column_letter(len(lab["headers"]))
    ws.auto_filter.ref = "A%d:%s%d" % (header_row, last_col, max(header_row, row_idx - 1))


def _info_sheet(ws, results: Dict[str, Any], lang: str) -> None:
    lab = labels(lang)
    info = lab["info"]
    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 70
    r = 1
    ws.cell(row=r, column=1, value=lab["title"]).font = TITLE_FONT
    r += 1
    ws.cell(row=r, column=1, value=info["generated"]).font = DATA_FONT
    ws.cell(row=r, column=2, value=_safe_text(str(results.get("generated_at") or ""))).font = DATA_FONT
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
        ws.cell(row=r, column=1, value=key).font = DATA_FONT
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
            ("%s : %s" % (info["failed"], m.get("error") or ""))
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
    """Écrit le classeur dans ``out_dir`` et rend son chemin."""
    lang = lang or (results.get("config") or {}).get("lang") or "fr"
    if lang not in LABELS:
        lang = "fr"
    wb = Workbook()
    _candidates_sheet(wb.active, results, lang)
    _info_sheet(wb.create_sheet(labels(lang)["info_sheet"]), results, lang)
    path = Path(out_dir) / file_name(results, lang)
    tmp = path.with_name("." + path.name + ".tmp")
    wb.save(str(tmp))
    tmp.replace(path)
    return path
