"""Pacing adaptatif (P3a) : le 'vrai filet' anti-flag. Pur, déterministe.

Crawler POLI — quand la cible pousse (429/Retry-After/challenge), on AUGMENTE
l'intervalle (capé) puis on REVIENT doucement vers la base quand ça se calme.
Ce n'est PAS de l'évasion : c'est ralentir quand le serveur le demande."""
from typing import Optional


class AdaptivePacer(object):
    def __init__(self, base_interval_s, max_interval_s=300.0,
                 backoff_factor=2.0, recover_factor=0.5):
        self.base = float(base_interval_s)
        self.max = float(max_interval_s)
        self.backoff_factor = float(backoff_factor)
        self.recover_factor = float(recover_factor)
        self.current = self.base

    def interval(self):
        return self.current

    def _clamp(self, value):
        return min(max(value, self.base), self.max)

    def penalize(self, retry_after=None):
        # type: (Optional[float]) -> None
        if retry_after is not None:
            self.current = self._clamp(float(retry_after))
        else:
            self.current = self._clamp(self.current * self.backoff_factor)

    def relax(self):
        self.current = max(self.base, self.current * self.recover_factor)
