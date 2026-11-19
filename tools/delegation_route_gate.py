"""Protected model-route detection and gateway-owned one-use grant consumption."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)


def _xai_fallback(value: Any) -> bool:
    if not isinstance(value, list):
        return False
    return any((item == "xai-oauth" or isinstance(item, Mapping)
                and item.get("provider") == "xai-oauth") for item in value)


def protected_route(route: Mapping[str, Any], config: Mapping[str, Any] | None = None) -> bool:
    """Protect Grok and Daybreak even if a route editor omits a marker."""
    provider = str(route.get("provider") or "").strip().lower()
    model = str(route.get("model") or "").strip().lower()
    if (provider == "xai-oauth" or route.get("daybreak") is True
            or model.startswith("gpt-daybreak-")):
        return True
    overrides = route.get("request_overrides")
    if isinstance(overrides, Mapping):
        body = overrides.get("extra_body")
        if isinstance(body, Mapping):
            access = body.get("access_programs")
            if isinstance(access, Mapping) and str(access.get("cyber", "")).startswith("daybreak_"):
                return True
    # The resolver inherits delegation.fallback_providers only if the route
    # does not explicitly provide one (including an empty list).
    fallback = route.get("fallback_providers")
    if fallback is None and not route.get("profile") and isinstance(config, Mapping):
        fallback = config.get("fallback_providers")
    return _xai_fallback(fallback)


def consume_route_grant(parent_agent: Any, name: str) -> bool:
    """Fail closed unless the UI armed this route for this conversation.

    Managed workers cross to the gateway over their authenticated owner RPC.
    In-process agents use that gateway's same private state. No model argument
    can create a grant.
    """
    from agent.runtime_session_store import call_off_event_loop, is_worker_process
    from gateway.session_context import get_session_env

    ui_session_id = get_session_env("HERMES_UI_SESSION_ID", "")
    if is_worker_process():
        try:
            from tools.async_delegation_worker import worker_ledger
            ledger = worker_ledger()
            store = ledger.store
            return bool(call_off_event_loop(store._apply, "route_gate.consume",
                                           {"name": name})["value"])
        except Exception:
            logger.exception("Failed to consume delegation route grant")
            return False
    from gateway.delegation_route_gates import consume
    from hermes_constants import get_hermes_home
    profile_id = str(get_hermes_home())
    session_id = ui_session_id or getattr(parent_agent, "session_id", "")
    try:
        return consume(profile_id, session_id, name)
    except ValueError:
        return False
