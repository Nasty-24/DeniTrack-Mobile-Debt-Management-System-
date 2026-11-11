"""The plain /health address that hosting platforms probe before sending traffic."""

import app.main as main


def test_root_health_answers_ok_when_the_database_is_reachable(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_root_health_reports_unavailable_when_the_database_is_down(client, monkeypatch):
    class DownEngine:
        def connect(self):
            raise OSError("database unreachable")

    monkeypatch.setattr(main, "engine", DownEngine())
    r = client.get("/health")
    assert r.status_code == 503
    assert r.json() == {"status": "unavailable"}
