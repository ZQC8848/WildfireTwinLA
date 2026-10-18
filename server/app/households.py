"""Synthetic household directory for the emergency contact demo.

Every building in buildings.json gets one household with a street address, an owner name, a
phone number and a language. All of it is generated with a fixed seed and none of it describes
a real person:

* Street names are real OpenStreetMap names (roads.json), but house numbers are random, so the
  full address is not a real address.
* Names come from common first and last name lists.
* Phone numbers use only (949) 555-0100 to 555-0199, the range the North American Numbering Plan
  reserves for fiction, so they can never ring a real line.

The directory stays on the server. Clients only ever receive the masked fields from `public()`.
"""

import json
import random
from dataclasses import dataclass
from math import hypot
from pathlib import Path

SEED = 2026
FICTIONAL_PREFIX = "+1949555"  # followed by 01XX

FIRST_EN = [
    "James",
    "Mary",
    "Robert",
    "Patricia",
    "John",
    "Jennifer",
    "Michael",
    "Linda",
    "David",
    "Elizabeth",
    "William",
    "Barbara",
    "Richard",
    "Susan",
    "Joseph",
    "Jessica",
    "Thomas",
    "Sarah",
    "Charles",
    "Karen",
    "Daniel",
    "Lisa",
    "Matthew",
    "Nancy",
    "Mark",
    "Ashley",
    "Steven",
    "Kimberly",
    "Paul",
    "Emily",
    "Andrew",
    "Donna",
    "Kevin",
    "Michelle",
    "Brian",
    "Carol",
    "Ryan",
    "Amanda",
    "Jason",
    "Melissa",
    "Eric",
    "Stephanie",
    "Scott",
    "Rebecca",
    "Gregory",
    "Laura",
    "Megan",
    "Kyle",
    "Rachel",
    "Noah",
    "Olivia",
]
FIRST_ES = [
    "Jose",
    "Maria",
    "Juan",
    "Guadalupe",
    "Carlos",
    "Rosa",
    "Luis",
    "Ana",
    "Miguel",
    "Carmen",
    "Jorge",
    "Elena",
    "Pedro",
    "Sofia",
    "Alejandro",
    "Lucia",
    "Ricardo",
    "Isabel",
    "Fernando",
    "Gabriela",
    "Javier",
    "Teresa",
    "Manuel",
    "Patricia",
    "Diego",
    "Laura",
]
LAST_EN = [
    "Smith",
    "Johnson",
    "Williams",
    "Brown",
    "Jones",
    "Miller",
    "Davis",
    "Wilson",
    "Anderson",
    "Taylor",
    "Thomas",
    "Moore",
    "Jackson",
    "Martin",
    "Lee",
    "Thompson",
    "White",
    "Harris",
    "Clark",
    "Lewis",
    "Robinson",
    "Walker",
    "Young",
    "Allen",
    "King",
    "Wright",
    "Scott",
    "Hill",
    "Green",
    "Adams",
    "Baker",
    "Nelson",
    "Carter",
    "Mitchell",
    "Roberts",
    "Campbell",
    "Parker",
    "Evans",
    "Edwards",
    "Collins",
    "Stewart",
    "Morris",
    "Murphy",
    "Cook",
    "Rogers",
    "Morgan",
    "Cooper",
    "Peterson",
    "Reed",
    "Bailey",
    "Kim",
    "Nguyen",
    "Chen",
    "Patel",
    "Park",
    "Tran",
    "Wong",
]
LAST_ES = [
    "Garcia",
    "Rodriguez",
    "Martinez",
    "Hernandez",
    "Lopez",
    "Gonzalez",
    "Perez",
    "Sanchez",
    "Ramirez",
    "Torres",
    "Flores",
    "Rivera",
    "Gomez",
    "Diaz",
    "Reyes",
    "Morales",
    "Cruz",
    "Ortiz",
    "Gutierrez",
    "Chavez",
    "Ramos",
    "Ruiz",
    "Mendoza",
    "Castillo",
]

# Community id prefix → city and a representative ZIP code
CITIES = {
    "sjc": ("San Juan Capistrano", "92675"),
    "scl": ("San Clemente", "92672"),
    "ladera": ("Ladera Ranch", "92694"),
    "esencia": ("Rancho Mission Viejo", "92694"),
}
BUCKET = 16  # grid cells per spatial bucket (400 m) for the nearest-street search


@dataclass(frozen=True)
class Household:
    id: str
    building_id: str
    cell: int
    x: float
    y: float
    address: str
    city: str
    zip: str
    owner: str
    phone_e164: str
    language: str
    vulnerable: bool
    community_id: str | None

    def public(self) -> dict:
        """Masked fields for clients: no full name, number or house number ever leaves the server."""
        return {
            "id": self.id,
            "buildingId": self.building_id,
            "cell": self.cell,
            "owner": mask_name(self.owner),
            "phone": mask_phone(self.phone_e164),
            "address": f"{mask_address(self.address)}, {self.city}",
            "language": self.language,
            "vulnerable": self.vulnerable,
            "communityId": self.community_id,
        }


def mask_name(name: str) -> str:
    first, _, last = name.partition(" ")
    return f"{first} {last[:1]}{'*' * max(3, len(last) - 1)}" if last else first


def mask_phone(e164: str) -> str:
    digits = e164.removeprefix("+1")
    return f"({digits[:3]}) {digits[3:6]}-{digits[6:8]}**"


def mask_address(address: str) -> str:
    number, _, street = address.partition(" ")
    return f"{number[:2]}{'*' * max(1, len(number) - 2)} {street}"


def _segments(roads: dict):
    """Named road segments in grid coordinates, bucketed for a nearest-segment search."""
    buckets: dict[tuple[int, int], list[tuple[float, float, float, float, str]]] = {}
    names = roads.get("names") or []
    for road, name in zip(roads["roads"], names, strict=False):
        # Homes are not addressed on freeways (class 0), so those segments are skipped
        if not name or road[0] == 0:
            continue
        pts = road[1:]
        for k in range(0, len(pts) - 2, 2):
            x0, y0, x1, y1 = pts[k], pts[k + 1], pts[k + 2], pts[k + 3]
            seg = (x0, y0, x1, y1, name)
            for bx in range(int(min(x0, x1) // BUCKET), int(max(x0, x1) // BUCKET) + 1):
                for by in range(int(min(y0, y1) // BUCKET), int(max(y0, y1) // BUCKET) + 1):
                    buckets.setdefault((bx, by), []).append(seg)
    return buckets


def _nearest_street(buckets, x: float, y: float) -> tuple[str, float]:
    """Nearest named street and the side of the street (sign of the cross product)."""
    bx, by = int(x // BUCKET), int(y // BUCKET)
    best = (float("inf"), "", 1.0)
    for radius in (1, 2, 4):
        for dx in range(-radius, radius + 1):
            for dy in range(-radius, radius + 1):
                for x0, y0, x1, y1, name in buckets.get((bx + dx, by + dy), ()):
                    vx, vy = x1 - x0, y1 - y0
                    length2 = vx * vx + vy * vy or 1e-9
                    t = max(0.0, min(1.0, ((x - x0) * vx + (y - y0) * vy) / length2))
                    d = hypot(x - x0 - t * vx, y - y0 - t * vy)
                    if d < best[0]:
                        best = (d, name, 1.0 if vx * (y - y0) - vy * (x - x0) >= 0 else -1.0)
        if best[1]:
            break
    return best[1] or "Ortega Highway", best[2]


def _city(community_id: str | None) -> tuple[str, str]:
    for prefix, city in CITIES.items():
        if community_id and community_id.startswith(prefix):
            return city
    return CITIES["sjc"]


def generate_households(grid_dir: str | Path, seed: int = SEED) -> list[Household]:
    grid_dir = Path(grid_dir)
    meta = json.loads((grid_dir / "grid.json").read_text())
    width = int(meta["width"])
    buildings = json.loads((grid_dir / "buildings.json").read_text())
    roads = json.loads((grid_dir / "roads.json").read_text())
    communities = json.loads((grid_dir / "communities.json").read_text())
    community_of: dict[int, str] = {}
    centroids: list[tuple[float, float, str]] = []
    for community in communities:
        cells = community["cells"]
        for cell in cells:
            community_of[cell] = community["id"]
        if cells:
            cx = sum(c % width for c in cells) / len(cells)
            cy = sum(c // width for c in cells) / len(cells)
            centroids.append((cx, cy, community["id"]))
    buckets = _segments(roads)
    rng = random.Random(seed)
    households: list[Household] = []
    for b in buildings:
        cell = int(b["cell"])
        x, y = cell % width + 0.5, cell // width + 0.5
        community = community_of.get(cell)
        nearest_community = community or (
            min(centroids, key=lambda c: hypot(c[0] - x, c[1] - y))[2] if centroids else None
        )
        city, zip_code = _city(nearest_community)
        street, side = _nearest_street(buckets, x, y)
        # House numbers: even on one side of the street, odd on the other, as in US addressing
        number = rng.randrange(100, 34999)
        number += (number % 2 == 1) == (side > 0)
        spanish = rng.random() < 0.25
        first = rng.choice(FIRST_ES if spanish and rng.random() < 0.8 else FIRST_EN)
        last = rng.choice(LAST_ES if spanish else LAST_EN)
        households.append(
            Household(
                id=f"hh-{b['id']}",
                building_id=str(b["id"]),
                cell=cell,
                x=x,
                y=y,
                address=f"{number} {street}",
                city=city,
                zip=zip_code,
                owner=f"{first} {last}",
                phone_e164=f"{FICTIONAL_PREFIX}01{rng.randrange(100):02d}",
                language="es" if spanish and rng.random() < 0.6 else "en",
                vulnerable=rng.random() < 0.08,
                community_id=community,
            )
        )
    return households
