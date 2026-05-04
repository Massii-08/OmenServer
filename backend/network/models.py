"""
Module Réseau — Modèles SQLAlchemy.

WolDevice : un appareil Wake-on-LAN enregistré.
NetworkLog : historique des mesures réseau (latence, débit).
"""

from sqlalchemy import Column, Integer, String, Float, DateTime
from datetime import datetime
from backend.database import Base


class WolDevice(Base):
    """
    Un appareil enregistré pour Wake-on-LAN.
    
    Le MAC address est l'identifiant unique de la carte réseau.
    L'IP hint aide à cibler le broadcast.
    """
    __tablename__ = "wol_devices"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)           # Nom de l'appareil (ex: "PC Bureau")
    mac_address = Column(String, nullable=False)     # Adresse MAC (XX:XX:XX:XX:XX:XX)
    ip_hint = Column(String, nullable=True)          # IP optionnelle (pour cibler le subnet)
    last_wake = Column(DateTime, nullable=True)      # Dernière fois réveillé
    created_at = Column(DateTime, default=datetime.utcnow)


class NetworkLog(Base):
    """
    Un point de mesure réseau.
    Stocke latence, débit et IP publique à un instant donné.
    """
    __tablename__ = "network_logs"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    latency_ms = Column(Float, nullable=True)         # Latence en ms (ping)
    download_mbps = Column(Float, nullable=True)       # Débit download en Mbps
    upload_mbps = Column(Float, nullable=True)         # Débit upload en Mbps
    public_ip = Column(String, nullable=True)          # IP publique
