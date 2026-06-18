"""Setup intelligent (P2) : probe difficulté → prompt → Claude génère
recette/plan/pacing → run sur un échantillon → preview. Seule étape IA.

fetch_full et claude sont injectés → testable sans réseau ni CLI."""
from typing import Any, Callable, Dict, Tuple

from backend.bots.harvester.recipe import Recipe

PACING_BY_TIER = {
    "facile": {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
    "moyen": {"min_interval_s": 5.0, "jitter": [2.0, 6.0]},
    "dur": {"min_interval_s": 20.0, "jitter": [8.0, 15.0]},
}


def probe_difficulty(status: int, headers: Dict[str, str]) -> str:
    h = {}
    for k, v in (headers or {}).items():
        h[k.lower()] = v
    if status == 429 or "retry-after" in h:
        return "dur"
    server = (h.get("server") or "").lower()
    if "cf-ray" in h or "cloudflare" in server:
        return "moyen"
    return "facile"


def pacing_for(tier: str) -> Dict[str, Any]:
    return PACING_BY_TIER.get(tier, PACING_BY_TIER["facile"])


def build_setup_prompt(url: str, instructions: str, sample_html: str, tier: str) -> str:
    snippet = (sample_html or "")[:6000]
    return (
        "You generate a DETERMINISTIC web-scraping recipe for a continuous harvester. "
        "No code — output ONLY a JSON object.\n\n"
        "=== TARGET URL ===\n{url}\n\n"
        "=== WHAT THE USER WANTS (natural language) ===\n{instr}\n\n"
        "=== OBSERVED DIFFICULTY TIER ===\n{tier} (facile=fast/no protection, "
        "moyen=Cloudflare-ish, dur=rate-limited)\n\n"
        "=== HTML SAMPLE OF THE PAGE (truncated) ===\n{html}\n\n"
        "=== OUTPUT SCHEMA (return EXACTLY this shape) ===\n"
        "{{\n"
        '  "recipe": {{\n'
        '    "item_selector": {{"tag": "...", "class": "..."}},   // the repeating record container\n'
        '    "fields": {{ "<field_name>": {{"selector": <sel>, "extract": "<how>"}} , ... }}\n'
        "  }},\n"
        '  "plan": {{"mode": "pagination"|"sitemap", "next_selector": {{"tag": "...", "class": "..."}} }},\n'
        '  "pacing": {{"min_interval_s": <float>, "jitter": [<lo>, <hi>]}}\n'
        "}}\n\n"
        "=== SELECTOR RULES ===\n"
        "- A selector is {{\"tag\": t}} and/or {{\"class\": c}} (matches a descendant of the item).\n"
        "- For 'the <a> inside the <h3>' use a DESCENDANT CHAIN: [{{\"tag\":\"h3\"}},{{\"tag\":\"a\"}}].\n"
        "- A field with NO selector extracts from the item element itself.\n"
        "- extract is one of: \"text\" (collapsed text), \"attr:NAME\" (an attribute), "
        "\"class:N\" (the N-th class token, 0-based).\n"
        "- NEVER create fields for personal data (name, email, phone, address, user id, etc.).\n"
        "- Pick pacing matching the difficulty tier (slower for moyen/dur).\n"
        "Return ONLY the JSON object, nothing else."
    ).format(url=url, instr=instructions, tier=tier, html=snippet)


def build_setup(url: str, instructions: str, *,
                fetch_full: Callable[[str], Tuple[int, Dict[str, str], str]],
                claude: Callable[[str], Dict[str, Any]]) -> Dict[str, Any]:
    status, headers, html = fetch_full(url)
    tier = probe_difficulty(status, headers)
    prompt = build_setup_prompt(url, instructions, html, tier)
    spec = claude(prompt)
    recipe_dict = spec["recipe"]
    recipe = Recipe.from_dict(recipe_dict)
    sample = recipe.extract(html)[:10]
    pacing = spec.get("pacing") or pacing_for(tier)
    return {
        "url": url,
        "difficulty": tier,
        "recipe": recipe_dict,
        "plan": spec.get("plan", {}),
        "pacing": pacing,
        "sample": sample,
    }
