"""
Catalogue d'actions du Diagnostic Bot — classifiées par tier de risque.

Synchro avec bot problème/agent/modules/actions.py. Note : ce fichier sert UNIQUEMENT
de référence côté hub (pour la doc) — l'agent embarque sa propre copie. Le hub ne
fait QUE relayer. On ne l'utilise pas directement dans le code (pas d'execution
côté serveur), mais il est utile pour le typage / la doc.

Quand on saura que l'agent est trustworthy, on pourra basculer en mode "le hub
liste les actions sans même attendre l'agent" — mais pour l'instant la source de
vérité reste l'agent (qui filtre par sys.platform sur la machine cible).
"""

# (Pas de code ici — la source de vérité est dans l'agent.
# Voir : tools/diagnostic_agent/modules/actions.py)
