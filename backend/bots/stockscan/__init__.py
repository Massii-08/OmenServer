"""Scanner d'actions — moteur déterministe (catalyseurs : news + prix + volume).

Spec : ``docs/superpowers/specs/2026-10-17-action-scanner-design.md``.
Aucun LLM, aucune dépendance hors de celles déjà installées (httpx, curl_cffi,
openpyxl). Lit les mémoires du coach du simulateur en LECTURE SEULE et n'écrit
que sous ``data/stock_scanner/``.
"""
