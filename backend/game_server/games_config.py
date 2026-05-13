"""
Configuration des jeux supportés — Registre de tous les jeux disponibles.

Chaque jeu a sa propre image Docker, ses ports par défaut,
et ses variables d'environnement spécifiques.

Pour ajouter un nouveau jeu, il suffit d'ajouter une entrée dans GAMES.
"""

GAMES = {
    "minecraft": {
        "name": "Minecraft Java",
        "icon": "⛏️",
        "image": "itzg/minecraft-server:latest",
        "default_port": 25565,
        "default_memory_mb": 2048,
        "port_protocol": "tcp",
        "env": {
            "EULA": "TRUE",
            "TYPE": "VANILLA",
            "ENABLE_RCON": "true",
            "RCON_PASSWORD": "omenserver",
        },
        "version_env": "VERSION",       # Variable d'env pour la version
        "memory_env": "MEMORY",          # Variable d'env pour la RAM
        "description": "Serveur Minecraft Java Edition (Vanilla, Paper, Forge, Fabric)",
    },
    "minecraft_bedrock": {
        "name": "Minecraft Bedrock",
        "icon": "🪨",
        "image": "itzg/minecraft-bedrock-server",
        "default_port": 19132,
        "default_memory_mb": 1024,
        "port_protocol": "udp",
        "env": {
            "EULA": "TRUE",
            "GAMEMODE": "survival",
        },
        "version_env": "VERSION",
        "memory_env": None,
        "description": "Serveur Minecraft Bedrock (Xbox, Mobile, Windows 10)",
    },
    "ark": {
        "name": "ARK: Survival Evolved",
        "icon": "🦖",
        "image": "hermsi/ark-server",
        "default_port": 27015,
        "default_memory_mb": 4096,
        "port_protocol": "udp",
        "env": {
            "SESSION_NAME": "OmenServer ARK",
            "ADMIN_PASSWORD": "changeme",
        },
        "version_env": None,
        "memory_env": None,
        "extra_ports": {"7777/udp": 7777, "7778/udp": 7778},
        "steam_app_id": 376030,   # App ID Steam d'ARK: Survival Evolved
        "mod_source": "steam",
        "description": "Serveur ARK avec dinosaures — demande beaucoup de RAM (4 Go+)",
    },
    "valheim": {
        "name": "Valheim",
        "icon": "⚔️",
        "image": "lloesche/valheim-server",
        "default_port": 2456,
        "default_memory_mb": 2048,
        "port_protocol": "udp",
        "env": {
            "SERVER_NAME": "OmenServer Valheim",
            "WORLD_NAME": "OmenWorld",
            "SERVER_PASS": "changeme",
        },
        "version_env": None,
        "memory_env": None,
        "extra_ports": {"2457/udp": 2457, "2458/udp": 2458},
        "steam_app_id": 892970,   # App ID Steam de Valheim
        "mod_source": "steam",
        "description": "Serveur Valheim — exploration viking coopérative",
    },
    "terraria": {
        "name": "Terraria",
        "icon": "🌳",
        "image": "ryshe/terraria:latest",
        "default_port": 7777,
        "default_memory_mb": 1024,
        "port_protocol": "tcp",
        "env": {
            "WORLD_FILENAME": "OmenWorld.wld",
            "AUTOCREATE": "2",
        },
        "version_env": None,
        "memory_env": None,
        "steam_app_id": 105600,   # App ID Steam de Terraria
        "mod_source": "steam",
        "description": "Serveur Terraria — aventure 2D sandbox",
    },
    "csgo2": {
        "name": "Counter-Strike 2",
        "icon": "🔫",
        "image": "joedwards32/cs2",
        "default_port": 27015,
        "default_memory_mb": 2048,
        "port_protocol": "udp",
        "env": {
            "CS2_SERVERNAME": "OmenServer CS2",
            "CS2_PORT": "27015",
        },
        "version_env": None,
        "memory_env": None,
        "steam_app_id": 730,      # App ID Steam de CS2
        "mod_source": "steam",
        "description": "Serveur Counter-Strike 2 compétitif",
    },
    "palworld": {
        "name": "Palworld",
        "icon": "🐾",
        "image": "thijsvanloef/palworld-server-docker",
        "default_port": 8211,
        "default_memory_mb": 4096,
        "port_protocol": "udp",
        "env": {
            "SERVER_NAME": "OmenServer Palworld",
            "ADMIN_PASSWORD": "changeme",
        },
        "version_env": None,
        "memory_env": None,
        "steam_app_id": 1623730,  # App ID Steam de Palworld
        "mod_source": "steam",
        "description": "Serveur Palworld — Pokémon meets survival",
    },
    "gmod": {
        "name": "Garry's Mod",
        "icon": "🔧",
        "image": "ich777/steamcmd:gmod",
        "default_port": 27015,
        "default_memory_mb": 2048,
        "port_protocol": "udp",
        "env": {
            "GAME_ID": "4020",
            "SERVER_NAME": "OmenServer GMod",
        },
        "version_env": None,
        "memory_env": None,
        "steam_app_id": 4000,     # App ID Steam de Garry's Mod (client)
        "mod_source": "steam",
        "description": "Serveur Garry's Mod — sandbox physique multijoueur",
    },
    "custom": {
        "name": "Jeu personnalisé",
        "icon": "🎮",
        "image": "",  # L'utilisateur entre l'image Docker
        "default_port": 27015,
        "default_memory_mb": 2048,
        "port_protocol": "tcp",
        "env": {},
        "version_env": None,
        "memory_env": None,
        "description": "Serveur personnalisé — entre l'image Docker de ton choix",
    },
    "velocity": {
        "name": "Velocity (Proxy)",
        "icon": "🌐",
        "image": "itzg/bungeecord:latest",
        "default_port": 25577,
        "default_memory_mb": 512,
        "port_protocol": "tcp",
        "env": {
            "TYPE": "VELOCITY",
        },
        "version_env": None,
        "memory_env": "MEMORY",
        "description": "Proxy Velocity — relie plusieurs serveurs Minecraft (recommandé, moderne)",
    },
    "bungeecord": {
        "name": "BungeeCord (Proxy)",
        "icon": "🔗",
        "image": "itzg/bungeecord:latest",
        "default_port": 25577,
        "default_memory_mb": 512,
        "port_protocol": "tcp",
        "env": {
            "TYPE": "BUNGEECORD",
        },
        "version_env": None,
        "memory_env": "MEMORY",
        "description": "Proxy BungeeCord/Waterfall — relie plusieurs serveurs Minecraft (classique)",
    },
}


def get_game_config(game_type: str) -> dict:
    """Retourne la config d'un jeu, ou celle de 'custom' par défaut."""
    return GAMES.get(game_type, GAMES["custom"])


def get_all_games() -> list:
    """Retourne la liste de tous les jeux supportés."""
    return [
        {"id": game_id, **{k: v for k, v in config.items() if k != "env"}}
        for game_id, config in GAMES.items()
    ]
