"""
Gestionnaire de modules — Le cœur de l'architecture modulaire.

Chaque module (Jeux, Bots, Fichiers...) est décrit par un dictionnaire
avec ses métadonnées. Le frontend utilise ces infos pour afficher les
cartes du hub et charger la bonne interface.

Pour la V1, les modules sont définis en dur dans le code.
Plus tard (V2+), chaque module pourra avoir son propre dossier avec
un fichier manifest.json.
"""

from typing import Optional


class ModuleManager:
    """
    Gère la liste des modules disponibles et leur statut.
    """

    def __init__(self):
        # Définition des modules disponibles
        # Chaque module a : id, nom, description, icône, couleur, et si il est actif
        self._modules = {
            "game_server": {
                "id": "game_server",
                "name": "Serveurs de jeux",
                "description": "Gérer tes serveurs Minecraft, ARK et autres jeux",
                "icon": "🎮",
                "color": "#10b981",  # Vert émeraude
                "enabled": True,
                "version": "1.0.0",
                "category": "gaming",
            },
            "bots": {
                "id": "bots",
                "name": "Bots & Automatisation",
                "description": "Déployer et monitorer tes bots Python",
                "icon": "🤖",
                "color": "#8b5cf6",  # Violet
                "enabled": True,  # V3 ✅
                "version": "1.0.0",
                "category": "automation",
            },
            "files": {
                "id": "files",
                "name": "Fichiers & Cloud",
                "description": "Cloud personnel + sync Google Drive",
                "icon": "📁",
                "color": "#3b82f6",  # Bleu
                "enabled": False,  # V3
                "version": "0.0.0",
                "category": "storage",
            },
            "media": {
                "id": "media",
                "name": "Média & Streaming",
                "description": "Serveur Plex/Jellyfin pour tes films et séries",
                "icon": "📺",
                "color": "#f59e0b",  # Orange
                "enabled": False,  # V4
                "version": "0.0.0",
                "category": "media",
            },
            "web": {
                "id": "web",
                "name": "Serveur Web",
                "description": "Héberger un site web ou une API",
                "icon": "🌐",
                "color": "#06b6d4",  # Cyan
                "enabled": False,  # V4
                "version": "0.0.0",
                "category": "web",
            },
            "vpn": {
                "id": "vpn",
                "name": "VPN",
                "description": "Accès sécurisé à ton réseau à distance",
                "icon": "🔒",
                "color": "#ef4444",  # Rouge
                "enabled": False,  # V4
                "version": "0.0.0",
                "category": "network",
            },
        }

    def get_all_modules(self) -> list:
        """Retourne la liste de tous les modules."""
        return list(self._modules.values())

    def get_enabled_modules(self) -> list:
        """Retourne uniquement les modules activés."""
        return [m for m in self._modules.values() if m["enabled"]]

    def get_module(self, module_id: str) -> Optional[dict]:
        """Retourne un module par son ID."""
        return self._modules.get(module_id)

    def is_module_enabled(self, module_id: str) -> bool:
        """Vérifie si un module est activé."""
        module = self._modules.get(module_id)
        return module["enabled"] if module else False


# Instance unique, importable partout
module_manager = ModuleManager()
