"""Protected delegation routes need an operator's one-use grant at dispatch."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from gateway.delegation_route_gates import armed, consume, set_armed
from tools.delegation_route_gate import protected_route


def test_one_grant_lets_exactly_one_concurrent_child_start(tmp_path):
    profile, session, route = str(tmp_path), "chat-one", "grok-design-consult"
    assert not armed(profile, session, route)
    set_armed(profile, session, route, True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: consume(profile, session, route), range(8)))
    assert results.count(True) == 1
    assert not armed(profile, session, route)
    assert not consume(profile, "another-chat", route)
    assert not consume(str(tmp_path / "other-profile"), session, route)


def test_worker_receipt_replay_does_not_spend_a_new_grant(tmp_path):
    profile, session, route = str(tmp_path), "chat-two", "oai-daybreak"
    set_armed(profile, session, route, True)
    assert consume(profile, session, route, "execution:1:11")
    set_armed(profile, session, route, True)
    assert consume(profile, session, route, "execution:1:11")
    assert armed(profile, session, route)
    assert consume(profile, session, route, "execution:1:12")
    assert not armed(profile, session, route)


def test_full_receipt_cache_refuses_new_spend_without_disarming(monkeypatch, tmp_path):
    from gateway import delegation_route_gates as gates
    profile, session, route = str(tmp_path), "bounded-chat", "grok"
    monkeypatch.setattr(gates, "_MAX_RECEIPTS", len(gates._receipts))
    set_armed(profile, session, route, True)
    assert not consume(profile, session, route, "new-execution:1:1")
    assert armed(profile, session, route)


@pytest.mark.parametrize(("route", "config", "expected"), [
    ({"provider": "xai-oauth", "model": "grok-4.7"}, {}, True),
    ({"provider": "openai-codex", "model": "gpt-6-sol", "daybreak": True}, {}, True),
    ({"provider": "openai-codex", "model": "gpt-daybreak-blue-latest"}, {}, True),
    ({"provider": "openai-codex", "model": "gpt-6-sol", "request_overrides": {
        "extra_body": {"access_programs": {"cyber": "daybreak_blue"}}}}, {}, True),
    ({"provider": "anthropic", "model": "claude-opus-5-5", "fallback_providers": [
        {"provider": "xai-oauth", "model": "grok-4.7"}]}, {}, True),
    ({"provider": "anthropic", "model": "claude-opus-5-5"}, {"fallback_providers": [
        {"provider": "xai-oauth", "model": "grok-4.7"}]}, True),
    ({"provider": "anthropic", "model": "claude-opus-5-5", "fallback_providers": []},
     {"fallback_providers": [{"provider": "xai-oauth", "model": "grok-4.7"}]}, False),
    ({"provider": "spark", "model": "qwen"}, {}, False),
    ({"profile": "other"}, {"fallback_providers": [{"provider": "xai-oauth"}]}, False),
])
def test_protected_route_matches_effective_provider_daybreak_and_fallback(route, config, expected):
    assert protected_route(route, config) is expected


def test_worker_consumes_only_its_verified_compression_lineage(monkeypatch, tmp_path):
    from gateway import session_worker
    profile = str(tmp_path)
    set_armed(profile, "root-chat", "grok-design-consult", True)
    set_armed(profile, "other-chat", "grok-design-consult", True)
    monkeypatch.setattr(session_worker, "_claim", lambda *_: "claim")
    monkeypatch.setattr(session_worker, "_verify", lambda *_: None)
    connection = SimpleNamespace(actor=SimpleNamespace(capabilities={"worker:adopt"}),
                                 authority=SimpleNamespace(profile_id=profile))
    from gateway import session_persistence
    monkeypatch.setattr(session_persistence, "authority_persistence",
                        lambda _: SimpleNamespace(lineage=SimpleNamespace(lineage=lambda sid: ("root-chat", sid))))
    params = {key: "x" for key in session_worker._SCOPE}
    params.update(epoch=1, sequence=5, operation="route_gate.consume",
                  payload={"name": "grok-design-consult"}, session_id="rotated-chat")
    assert asyncio.run(session_worker._consume_route_gate(connection, None, params)) == {"value": True}
    assert not armed(profile, "root-chat", "grok-design-consult")
    assert armed(profile, "other-chat", "grok-design-consult")
    # A model cannot choose another UI session in the worker payload.
    params["payload"]["ui_session_id"] = "other-chat"
    from persistence.core.errors import AuthorityRefusal
    with pytest.raises(AuthorityRefusal, match="invalid_params"):
        asyncio.run(session_worker._consume_route_gate(connection, None, params))
    assert armed(profile, "other-chat", "grok-design-consult")


def test_route_gate_post_rejects_ordinary_dashboard_principal():
    from fastapi import HTTPException, Request
    from hermes_cli.web_routers.delegation import set_route_gate

    body = {"session_id": "chat", "name": "grok-design-consult", "armed": True}
    for principal in (None, {"purpose": "native-http"}):
        request = Request({"type": "http", "method": "POST", "path": "/api/delegation/route-gates",
                           "headers": [], "state": {"native_http_principal": principal}})
        with pytest.raises(HTTPException) as raised:
            asyncio.run(set_route_gate(body, request))
        assert raised.value.status_code == 403
