# WildfireTwinLA realtime server

FastAPI MVP for normalized hotspot ingestion, incident clustering, alert evaluation,
resident opt-in and WebSocket delivery. The architecture and production boundaries are in
[`docs/backend-design.md`](../docs/backend-design.md).

```bash
cd server
python -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
cp .env.example .env
uvicorn app.main:app --reload
```

Run the dependency-free unit tests with:

```bash
python -m unittest discover -s tests -v
```

Pollers default to disabled so local runs do not require external credentials. `GET /healthz`
and the WebSocket at `/ws?mode=live` are ready for frontend integration.

