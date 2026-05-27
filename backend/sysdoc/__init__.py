"""
Module sysdoc — intégration du Diagnostic Bot dans OmenServer.

Le bot d'origine vit dans `~/omenserver Project/bot problème/` (sibling project).
Ce module porte la même logique mais branchée sur l'auth OmenServer (JWT user) et
exposée comme un onglet SPA dans le panel.

Endpoints :
- WS  /ws/sysdoc/agent/{username}   ← l'agent (Python) pousse ses métriques
- WS  /ws/sysdoc/viewer/{username}  ← le dashboard reçoit et envoie des commandes
- GET /api/sysdoc/me                ← retourne le username + diagnostic_agent_url
                                       que l'agent doit utiliser pour se connecter

Sécurité : un user ne peut viewer QUE son propre agent (username dans le path
DOIT matcher le sub du JWT, sauf admin qui peut tout voir).
"""
