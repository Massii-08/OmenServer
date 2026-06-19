"""Config figée d'un harvest (url + recette + plan + pacing + clé de feed),
persistée dans run_dir/config.json. Pure."""
import json
import os
from typing import Any, Dict

from backend.bots.harvester.recipe import Recipe


class HarvestConfig(object):
    def __init__(self, url: str, recipe: Recipe, plan: Dict[str, Any],
                 pacing: Dict[str, Any], feed_key: str) -> None:
        self.url = url
        self.recipe = recipe
        self.plan = plan
        self.pacing = pacing
        self.feed_key = feed_key

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "HarvestConfig":
        return cls(
            url=d["url"],
            recipe=Recipe.from_dict(d["recipe"]),
            plan=d.get("plan", {}),
            pacing=d.get("pacing", {}),
            feed_key=d["feed_key"],
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "recipe": self.recipe.to_dict(),
            "plan": self.plan,
            "pacing": self.pacing,
            "feed_key": self.feed_key,
        }

    @classmethod
    def load(cls, run_dir: str) -> "HarvestConfig":
        with open(os.path.join(run_dir, "config.json"), "r", encoding="utf-8") as f:
            return cls.from_dict(json.load(f))

    def save(self, run_dir: str) -> None:
        os.makedirs(run_dir, exist_ok=True)
        path = os.path.join(run_dir, "config.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)
        # config.json porte des secrets (feed_key, éventuels creds proxy) -> 600
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
