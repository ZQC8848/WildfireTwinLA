# /// script
# dependencies = ["requests"]
# ///
"""Tripo 图生 3D：把参考图批量转成 GLB。

用法：uv run tools/assets/tripo_generate.py name1 name2 ...（不给名字则处理 concepts 下全部）
API key 从环境变量或仓库根目录 .env 的 TRIPO_API_KEY 读取，不会打印。
"""

import concurrent.futures as cf
import json
import os
import pathlib
import sys
import time

import requests

API = "https://api.tripo3d.ai/v2/openapi"
ASSETS = pathlib.Path.home() / "Assets/WildfireTwinLA"
CONCEPTS = ASSETS / "concepts"
OUT = ASSETS / "tripo"
SKIP = {"transmission-tower"}  # 钢格构在 Blender 里手工建模
FACE_LIMIT = {"tree": 8000, "house": 6000}


def load_key() -> str:
    key = os.environ.get("TRIPO_API_KEY")
    if not key:
        env = pathlib.Path(__file__).resolve().parents[2] / ".env"
        for line in env.read_text().splitlines():
            if line.startswith("TRIPO_API_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        sys.exit("TRIPO_API_KEY not found")
    return key


S = requests.Session()
S.headers["Authorization"] = f"Bearer {load_key()}"


def call(method: str, path: str, **kw) -> dict:
    r = S.request(method, API + path, timeout=120, **kw)
    body = r.json()
    if r.status_code != 200 or body.get("code") != 0:
        raise RuntimeError(f"{method} {path}: HTTP {r.status_code} {body}")
    return body["data"]


def generate(name: str) -> str:
    glb = OUT / f"{name}.glb"
    if glb.exists():
        return f"{name}: skip (exists)"
    img = CONCEPTS / f"{name}.png"
    with img.open("rb") as f:
        token = call("POST", "/upload", files={"file": (img.name, f, "image/png")})["image_token"]
    kind = "house" if name.startswith(("house", "apartment", "fire-station")) else "tree"
    task = call(
        "POST",
        "/task",
        json={
            "type": "image_to_model",
            "file": {"type": "png", "file_token": token},
            "texture": True,
            "pbr": False,
            "face_limit": FACE_LIMIT[kind],
        },
    )["task_id"]
    t0 = time.time()
    while True:
        data = call("GET", f"/task/{task}")
        status = data["status"]
        if status == "success":
            break
        if status in ("failed", "cancelled", "banned", "expired", "unknown"):
            raise RuntimeError(f"{name}: task {task} {status}")
        if time.time() - t0 > 900:
            raise RuntimeError(f"{name}: task {task} timed out")
        time.sleep(5)
    out = data.get("output", {})
    url = out.get("model") or out.get("pbr_model") or out.get("base_model")
    if not url:
        raise RuntimeError(f"{name}: no model url in output keys {list(out)}")
    glb.write_bytes(requests.get(url, timeout=300).content)
    (OUT / f"{name}.task.json").write_text(json.dumps({"task_id": task, "status": status, "output_keys": list(out)}, indent=2))
    return f"{name}: ok {glb.stat().st_size // 1024} KB in {time.time() - t0:.0f}s"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    names = sys.argv[1:] or sorted(p.stem for p in CONCEPTS.glob("*.png") if p.stem not in SKIP)
    print("balance before:", call("GET", "/user/balance")["balance"], flush=True)
    with cf.ThreadPoolExecutor(max_workers=3) as pool:
        futs = {pool.submit(generate, n): n for n in names}
        for fut in cf.as_completed(futs):
            try:
                print(fut.result(), flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"{futs[fut]}: ERROR {e}", flush=True)
    print("balance after:", call("GET", "/user/balance")["balance"], flush=True)


if __name__ == "__main__":
    main()
