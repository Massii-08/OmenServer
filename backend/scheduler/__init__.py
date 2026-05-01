"""
Scheduler — Tâches planifiées pour OmenServer.

Permet de programmer des actions automatiques :
- Sauvegardes automatiques (toutes les X heures)
- Redémarrages planifiés
- Nettoyage des vieilles sauvegardes

Utilise APScheduler avec un stockage en base SQLAlchemy.
"""
