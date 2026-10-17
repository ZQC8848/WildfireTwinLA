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
5×5 north-to-south wind field. The default bbox and replay now target the Norte Fire; use
`WS /ws?mode=replay` (or `event=norte`) for that dataset. Set
`WILDFIRE_ENABLE_DIRECT_GOES=true` to decode NOAA GOES-18
ABI-L2-FDCC NetCDF directly. Configure the three `WILDFIRE_RETELL_*` values to enable calls.

Useful integration points:

- `GET /readyz` reports provider watermarks and whether Retell is configured.
- `WS /ws?mode=live` sends a snapshot followed by sequenced hotspot, incident, wind and alert events.
- `POST /api/v1/risks/evaluate` consumes the simulator's community arrival probabilities.
- `POST /api/v1/risks/evaluate-batch` is the integration point for module C scenarios.
- `GET/POST /api/v1/official-orders` stores authoritative orders separately and pushes them with `official: true`.
- `POST /api/v1/residents` and `DELETE /api/v1/residents/{id}` implement opt-in and revocation.
- `POST /webhooks/retell` verifies Retell signatures and stores call outcomes.
- `GET /metrics` exports Prometheus-compatible service counts.

Registration returns a one-time `revoke_token`; clients must retain it and send it as
`X-Revocation-Token` when deleting a registration. Internal ingestion endpoints accept
`X-Internal-Key`, which is mandatory when `WILDFIRE_ENV=production`.

This service is a non-official decision-support system. Do not represent its modeled alerts as
government evacuation orders.
