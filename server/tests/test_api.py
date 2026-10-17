from fastapi.testclient import TestClient

from app import main
from app.store import Store


def test_health_registration_and_websocket_snapshot(tmp_path, monkeypatch) -> None:
    test_store = Store(str(tmp_path / "api.db"))
    monkeypatch.setattr(main, "store", test_store)
    monkeypatch.setattr(main, "service", None)

    with TestClient(main.app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        assert client.get("/readyz").status_code == 200
        response = client.post(
            "/api/v1/residents",
            json={
                "name": "Test Resident",
                "phone_e164": "+12135550123",
                "address": "100 Test Avenue",
                "community_id": "altadena",
                "consent": True,
            },
        )
        assert response.status_code == 201
        assert response.json()["phone_masked"] == "***0123"
        resident = response.json()
        assert (
            client.delete(
                f"/api/v1/residents/{resident['id']}",
                headers={"X-Revocation-Token": resident["revoke_token"]},
            ).status_code
            == 204
        )
        order = client.post(
            "/api/v1/official-orders",
            json={
                "id": "la-order-1",
                "community_id": "altadena",
                "level": "order",
                "headline": "Evacuate now",
                "source": "LA County",
                "issued_at": "2026-10-16T20:00:00Z",
            },
        )
        assert order.status_code == 200
        assert client.get("/api/v1/official-orders").json()[0]["level"] == "order"
        risks = client.post(
            "/api/v1/risks/evaluate-batch",
            json=[
                {
                    "community_id": "altadena",
                    "incident_id": "fire-1",
                    "probability_1h": 0.6,
                    "probability_3h": 0.8,
                    "probability_6h": 0.9,
                    "eta_min": 30,
                }
            ],
        )
        assert risks.status_code == 200
        assert risks.json()[0]["current"] == 3
        with client.websocket_connect("/ws?mode=live") as websocket:
            snapshot = websocket.receive_json()
            assert snapshot["type"] == "snapshot"
            assert snapshot["incidents"] == []
            websocket.send_text("ping")
            assert websocket.receive_text() == "pong"
        with client.websocket_connect("/ws?mode=replay&event=norte&speed=100000") as websocket:
            replay = websocket.receive_json()
            assert replay["type"] == "snapshot"
            assert replay["event"] == "norte"
