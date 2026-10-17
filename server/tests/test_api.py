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
        with client.websocket_connect("/ws?mode=live") as websocket:
            snapshot = websocket.receive_json()
            assert snapshot["type"] == "snapshot"
            assert snapshot["data"]["incidents"] == []
            websocket.send_text("ping")
            assert websocket.receive_text() == "pong"
