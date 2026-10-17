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

Run lint and tests with:

```bash
ruff check .
pytest -q
```

Pollers default to disabled so local runs do not require external credentials. To enable the
live backend, set `WILDFIRE_ENABLE_POLLERS=true` and provide a NASA FIRMS map key. FIRMS
VIIRS/MODIS and GOES NRT are normalized to the same hotspot model; Open-Meteo provides a
5×5 wind field. Configure the three `WILDFIRE_RETELL_*` values to enable calls.

Useful integration points:

- `GET /readyz` reports provider watermarks and whether Retell is configured.
- `WS /ws?mode=live` sends a snapshot followed by sequenced hotspot, incident, wind and alert events.
- `POST /api/v1/risks/evaluate` consumes the simulator's community arrival probabilities.
- `POST /api/v1/residents` and `DELETE /api/v1/residents/{id}` implement opt-in and revocation.
- `POST /webhooks/retell` verifies Retell signatures and stores call outcomes.

This service is a non-official decision-support system. Do not represent its modeled alerts as
government evacuation orders.
