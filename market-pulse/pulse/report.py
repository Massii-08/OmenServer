"""Rapport quotidien en italien — texte brut, déterministe, sans I/O.

Le destinataire est un investisseur particulier âgé : le rapport dit ce QUI
S'EST PASSÉ, jamais ce qu'il faudrait faire. Aucune recommandation, aucune
prévision — c'est la ligne rouge du bot, et un test la verrouille en
interdisant tout un vocabulaire prescriptif.

Le texte est calibré pour 78 colonnes : il est lu tel quel dans un fichier
.txt, dans un <pre> du dashboard et dans un message Telegram.
"""
import math
import textwrap
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

WIDTH = 78
ND = "n/d"

WEEKDAYS_IT = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì",
               "Sabato", "Domenica"]
MONTHS_IT = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
             "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"]

STATUS_IT = {"open": "aperto", "closed": "chiuso", "unknown": "stato ignoto"}

# Indices mis en avant dans les statistiques : les sortir tous ferait cent
# lignes de tableau pour un lecteur qui en veut quatre.
FEATURED = ("^GSPC", "FTSEMIB.MI", "^GDAXI", "^N225")


# --------------------------------------------------------------------------
# Formateurs — le format italien n'est pas cosmétique : « 51,698.19 » se lit
# « cinquante et un virgule six » pour un lecteur italien.
# --------------------------------------------------------------------------

def _as_float(value) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def fmt_number(value, decimals: int = 2) -> str:
    """51698.19 → « 51.698,19 ». Valeur inutilisable → « n/d »."""
    f = _as_float(value)
    if f is None:
        return ND
    # On formate à l'anglo-saxonne puis on ÉCHANGE les deux séparateurs.
    plain = "{0:,.{1}f}".format(f, decimals)
    return plain.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def fmt_pct(value, decimals: int = 2) -> str:
    """0.41 → « +0,41% ». Le signe est toujours porté, sauf à zéro : un
    « -0,00% » sur un arrondi ferait croire à une baisse."""
    f = _as_float(value)
    if f is None:
        return ND
    rounded = round(f, decimals)
    body = fmt_number(abs(rounded), decimals)
    if rounded > 0:
        return "+" + body + "%"
    if rounded < 0:
        return "-" + body + "%"
    return body + "%"


def _round_half_away(x: float) -> int:
    """Arrondi « à la moitié on s'éloigne de zéro ».

    round() de Python arrondit à l'entier PAIR (25,5 → 26 mais 24,5 → 24), ce
    qui donnerait des points de base incohérents d'un jour à l'autre.
    """
    return int(math.floor(x + 0.5)) if x >= 0 else int(math.ceil(x - 0.5))


def fmt_bp(delta_points) -> str:
    """Écart de TAUX en points de base : 0.04 point → « +4 pb ».

    Un rendement qui passe de 4,641 % à 4,592 % n'a pas « baissé de 1,06 % » —
    il a perdu 5 points de base. C'est la seule lecture juste, et celle que
    l'utilisateur connaît par ses obligations.
    """
    f = _as_float(delta_points)
    if f is None:
        return ND
    # round(...,9) d'abord : 0.255*100 vaut 25.499999999999996 en flottant.
    bp = _round_half_away(round(f * 100.0, 9))
    if bp > 0:
        return "+%d pb" % bp
    if bp < 0:
        return "-%d pb" % abs(bp)
    return "0 pb"


# --------------------------------------------------------------------------
# Nettoyage et mise en page
# --------------------------------------------------------------------------

def _clean(text) -> str:
    """Neutralise ce qui casserait un rapport texte : tabulations, cloche,
    caractères de contrôle venus d'un flux mal formé."""
    s = "" if text is None else str(text)
    return "".join(ch if ch.isprintable() else " " for ch in s).strip()


def _wrap(text: str, indent: str = "", subsequent: Optional[str] = None) -> List[str]:
    sub = indent if subsequent is None else subsequent
    return textwrap.wrap(text, width=WIDTH, initial_indent=indent,
                         subsequent_indent=sub) or [indent.rstrip()]


def _title(text: str) -> List[str]:
    return ["", text, "─" * min(len(text), WIDTH)]


def _it_date(day: str) -> str:
    """« 2026-04-08 » → « 08/04/2026 » (jamais l'ordre américain)."""
    try:
        return datetime.strptime(day, "%Y-%m-%d").strftime("%d/%m/%Y")
    except (TypeError, ValueError):
        return _clean(day)


def _previous_business_day(day: str) -> Optional[str]:
    try:
        d = datetime.strptime(day, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None
    step = 1
    while True:
        prev = d.toordinal() - step
        from datetime import date as _date
        cand = _date.fromordinal(prev)
        if cand.weekday() < 5:      # lundi..vendredi
            return cand.strftime("%Y-%m-%d")
        step += 1


# --------------------------------------------------------------------------
# Rendu d'un marché
# --------------------------------------------------------------------------

def _price_text(market: Dict[str, Any]) -> str:
    kind = market.get("kind")
    price = market.get("price")
    if _as_float(price) is None:
        return ND
    if kind == "fx":
        return fmt_number(price, 4)
    if kind == "rate":
        return fmt_number(price, 2) + "%"
    return fmt_number(price)


def _change_text(market: Dict[str, Any]) -> str:
    """Variation du jour, dans l'unité qui convient au type d'instrument."""
    if market.get("kind") == "rate":
        price, prev = _as_float(market.get("price")), _as_float(market.get("prev_close"))
        if price is None or prev is None:
            return ND
        return fmt_bp(price - prev)
    return fmt_pct(market.get("change_pct"))


def _clock_chunks(market: Dict[str, Any]) -> List[str]:
    clock = market.get("clock") or {}
    out = [STATUS_IT.get(clock.get("status"), STATUS_IT["unknown"])]
    if clock.get("local_time"):
        out.append("ora locale %s" % _clean(clock["local_time"]))
    if clock.get("status") == "closed" and clock.get("session_open"):
        # On donne l'HEURE d'apertura, pas la date : les jours fériés sont
        # inconnus ici, annoncer « domani » serait un pari.
        out.append("apertura alle %s" % _clean(clock["session_open"]))
    elif clock.get("status") == "open" and clock.get("session_close"):
        out.append("chiusura alle %s" % _clean(clock["session_close"]))
    return out


def _gap_chunks(market: Dict[str, Any]) -> List[str]:
    gap = market.get("gap") or {}
    if market.get("gap_note") == "open_non_significativo":
        # Mieux vaut dire « pas mesurable ici » qu'afficher un 0,00 % qui
        # passerait pour une séance ouverte sans écart (cf. ^FTSE).
        return ["gap non calcolabile: questa borsa non pubblica un vero "
                "prezzo di apertura"]
    if not gap or _as_float(gap.get("gap_pct")) is None:
        return []
    pct = fmt_pct(gap.get("gap_pct"))
    if market.get("gap_is_today"):
        out = ["gap ap. %s" % pct]
    else:
        out = ["ult. gap %s del %s" % (pct, _it_date(gap.get("date")))]
    prev_date, day = gap.get("prev_date"), gap.get("date")
    if prev_date and day and prev_date != _previous_business_day(day):
        # Séance manquante entre les deux (férié ou trou de données) : le dire
        # plutôt que de laisser croire à la veille.
        out.append("rispetto alla chiusura del %s" % _it_date(prev_date))
    return out


def _market_lines(market: Dict[str, Any]) -> List[str]:
    label = _clean(market.get("label") or market.get("symbol") or "?")
    head = "  %-24s %12s %10s" % (label[:24], _price_text(market), _change_text(market))
    lines = [head.rstrip()]
    chunks = _clock_chunks(market) + _gap_chunks(market)
    if chunks:
        lines.extend(_wrap(" · ".join(chunks), indent="    "))
    return lines


def _section(title: str, markets: List[Dict[str, Any]],
             note: Optional[List[str]] = None) -> List[str]:
    if not markets:
        return []
    lines = _title(title)
    if note:
        # Chaque phrase est enveloppée SÉPARÉMENT : une phrase courte reste
        # ainsi d'un seul tenant sur sa ligne, au lieu d'être coupée au
        # milieu par le remplissage du paragraphe.
        for sentence in note:
            lines.extend(_wrap(sentence, indent="  "))
        lines.append("")
    for market in markets:
        lines.extend(_market_lines(market))
    return lines


# --------------------------------------------------------------------------
# Sections annexes
# --------------------------------------------------------------------------

def _history_section(history: Optional[Dict[str, Any]]) -> List[str]:
    stats = (history or {}).get("stats") or {}
    if not stats:
        return []
    keys = [s for s in FEATURED if s in stats] or list(stats)[:4]
    lines = _title("STATISTICHE STORICHE")
    lines.extend(_wrap(
        "Osservazioni del passato (ultimo anno di sedute). Descrivono ciò che "
        "è già accaduto e non dicono nulla su ciò che accadrà.", indent="  "))
    for symbol in keys:
        entry = stats.get(symbol) or {}
        n = entry.get("n_sessions")
        lines.append("")
        lines.append("  %s — %s sedute" % (
            _clean(entry.get("label") or symbol),
            n if isinstance(n, int) else ND))
        for day, st in (entry.get("weekday_stats") or {}).items():
            st = st or {}
            avg_abs = st.get("avg_abs_gap_pct")
            lines.append("    %-11s n=%-4s medio %-8s |medio| %-7s in rialzo %s" % (
                _clean(day), st.get("n", ND), fmt_pct(st.get("avg_gap_pct")),
                fmt_number(avg_abs) + ("%" if _as_float(avg_abs) is not None else ""),
                fmt_number(st.get("pct_up"), 1) + "%"))
        biggest = entry.get("biggest_gaps") or []
        if biggest:
            parts = ["%s %s" % (_it_date(g.get("date")), fmt_pct(g.get("gap_pct")))
                     for g in biggest if g]
            lines.extend(_wrap("gap più grandi: " + " · ".join(parts),
                               indent="    ", subsequent="      "))
    return lines


def _news_section(news: Optional[Dict[str, Any]]) -> List[str]:
    if not news:
        return []
    items = news.get("items") or []
    themes = news.get("themes") or []
    failed = news.get("sources_failed") or []
    if not items and not themes and not failed:
        return []

    lines = _title("NOTIZIE")
    by_source = {}          # type: Dict[str, List[Dict[str, Any]]]
    order = []              # type: List[str]
    for item in items:
        src = _clean((item or {}).get("source")) or "Altre fonti"
        if src not in by_source:
            by_source[src] = []
            order.append(src)
        by_source[src].append(item or {})

    for src in order:
        lines.append("")
        lines.append("  " + src)
        for item in by_source[src]:
            hour = ""
            published = item.get("published")
            if isinstance(published, (int, float)):
                hour = datetime.fromtimestamp(
                    published, ZoneInfo("Europe/Rome")).strftime("%H:%M") + "  "
            lines.extend(_wrap(hour + _clean(item.get("title")),
                               indent="    ", subsequent="      "))

    if themes:
        parts = ["%s (%s)" % (_clean(t.get("theme")), t.get("count"))
                 for t in themes if t]
        lines.append("")
        lines.extend(_wrap("Temi ricorrenti: " + " · ".join(parts), indent="  "))
    if failed:
        parts = ["%s (%s)" % (_clean(f.get("source")), _clean(f.get("error")))
                 for f in failed if f]
        lines.extend(_wrap("Fonti non raggiunte: " + " · ".join(parts), indent="  "))
    return lines


def _errors_section(errors: List[Dict[str, Any]]) -> List[str]:
    if not errors:
        return []
    lines = _title("DATI MANCANTI")
    lines.extend(_wrap(
        "Questi strumenti non sono stati recuperati: il resto del rapporto "
        "resta valido, ma è incompleto.", indent="  "))
    for err in errors:
        lines.extend(_wrap("%s — %s" % (_clean((err or {}).get("symbol")),
                                        _clean((err or {}).get("error"))),
                           indent="    ", subsequent="      "))
    return lines


# --------------------------------------------------------------------------
# Assemblage
# --------------------------------------------------------------------------

def _header(now_ts: int, tz_name: str) -> List[str]:
    moment = datetime.fromtimestamp(now_ts, ZoneInfo(tz_name))
    stamp = "%s %d %s %d, ore %s" % (
        WEEKDAYS_IT[moment.weekday()], moment.day, MONTHS_IT[moment.month - 1],
        moment.year, moment.strftime("%H:%M"))
    return ["MARKET PULSE — " + stamp,
            "═" * WIDTH,
            "Documento informativo: solo fatti osservati, "
            "nessuna indicazione operativa."]


def build_report(snapshot: Dict[str, Any], history: Optional[Dict[str, Any]] = None,
                 news: Optional[Dict[str, Any]] = None, now_ts: Optional[int] = None,
                 tz_name: str = "Europe/Rome") -> str:
    """Rapport complet en italien, prêt à lire.

    `now_ts` est injecté pour que les tests soient déterministes ; à défaut on
    prend l'horodatage du snapshot (jamais l'horloge système directement).
    """
    if now_ts is None:
        now_ts = int(snapshot.get("generated_at") or 0)
    markets = snapshot.get("markets") or []
    errors = snapshot.get("errors") or []

    lines = _header(now_ts, tz_name)

    if not markets:
        lines.append("")
        lines.extend(_wrap(
            "Nessun dato di mercato è stato recuperato in questa rilevazione. "
            "Gli strumenti in errore sono elencati qui sotto."))
        lines.extend(_errors_section(errors))
        return _finish(lines)

    def pick(**criteria):
        out = []
        for m in markets:
            if all(m.get(k) in v for k, v in criteria.items()):
                out.append(m)
        return out

    rates = pick(kind=("rate", "volatility"))
    rate_ids = {id(m) for m in rates}
    asia = [m for m in pick(region=("asia",)) if id(m) not in rate_ids]
    glob = [m for m in pick(region=("global",), kind=("future", "fx", "commodity"))]
    europe = [m for m in pick(region=("europe",)) if id(m) not in rate_ids]
    usa = [m for m in pick(region=("usa",)) if id(m) not in rate_ids]
    placed = rate_ids | {id(m) for m in asia + glob + europe + usa}
    others = [m for m in markets if id(m) not in placed]

    lines += _section("ASIA — chiusura", asia)
    lines += _section("FUTURES, VALUTE E MATERIE PRIME", glob)
    lines += _section("TASSI E VOLATILITÀ", rates)
    lines += _section(
        "EUROPA", europe,
        note=["Su questa fonte non esiste un future europeo quotato:",
              "nessun valore di apertura europea viene calcolato qui.",
              "Seguono i fatti già noti che precedono la seduta."])
    lines += _section("USA", usa)
    lines += _section("ALTRI MERCATI", others)
    lines += _history_section(history)
    lines += _news_section(news)
    lines += _errors_section(errors)
    return _finish(lines)


def _finish(lines: List[str]) -> str:
    """Garde-fou final : aucune ligne au-delà de 78 colonnes, aucun caractère
    de contrôle. Le reste du module vise déjà la largeur, ceci la garantit
    même sur une donnée inattendue."""
    out = []
    for line in lines:
        line = "".join(ch if ch.isprintable() else " " for ch in line).rstrip()
        if len(line) <= WIDTH:
            out.append(line)
            continue
        indent = " " * (len(line) - len(line.lstrip()))
        out.extend(textwrap.wrap(line, width=WIDTH, initial_indent="",
                                 subsequent_indent=indent + "  ") or [line[:WIDTH]])
    return "\n".join(out) + "\n"
