"""Kanban chat handoff's native wire boundary, not the classic sidecar contract.

Real AuthorityConnection dispatch/schema, SQLite, compression resolver and durable
admission. Bootstrap/environment activation and model scheduling are not exercised:
this fixture has an isolated home and must never launch an agent or install packages.
"""
import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def conversation(tmp_path, monkeypatch):
    # Keep installer/recovery side effects out, without replacing the runtime
    # bootstrap or any session/authorization behavior.
    from pm import environments
    from hermes_cli import venv_sync, _early_recovery
    monkeypatch.setattr(environments, 'activate_dependencies', lambda _root: None)
    monkeypatch.setattr(venv_sync, 'prepare_launch', lambda *_args: None)
    monkeypatch.setattr(_early_recovery, 'recover_if_needed', lambda _root: None)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.chdir(tmp_path)
    from pathlib import Path
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    from gateway import session_local_inventory
    monkeypatch.setattr(session_local_inventory, '_start_update_prefetch', lambda: None)
    from tests.gateway.test_local_resume_compression_child import _compressed
    compressed = await _compressed(tmp_path, monkeypatch)
    from gateway import run
    monkeypatch.setattr(run, '_load_gateway_config', lambda *_args, **_kwargs: {'platform_toolsets': {'cli': []}})

    # Omit only the unrelated tool/model/skills inventory, preserving the real
    # snapshot builder, local creation policy/source, and strict native schema.
    monkeypatch.setattr(session_local_inventory, 'session_inventory', lambda *_args: {})
    yield compressed


def _connection(authority):
    from gateway.session_controls import AuthorityConnection
    return AuthorityConnection(authority, object(), {
        'provider': 'local', 'user_id': 'owner', 'profile_id': 'fixture',
        'instance_id': authority.instance_id,
        'capabilities': ['session:create', 'session:read', 'session:control', 'session:submit'],
    })


async def _rpc(connection, method, **params):
    return await connection.dispatch({'id': method, 'method': method, 'params': params})


@pytest.mark.asyncio
async def test_old_notification_list_params_are_rejected_by_native_handler(conversation):
    conn = _connection(conversation.warm)
    # Even without the old unsupported `profile` field, 1000 is invalid.
    reply = await _rpc(conn, 'session.list', include_hidden=True, limit=1000)
    assert reply['error']['data']['reason'] == 'invalid_params', reply
    valid = await _rpc(conn, 'session.list', include_hidden=True, limit=200)
    assert 'result' in valid, valid
    await conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('cold', [False, True])
async def test_exact_middle_resume_includes_closed_and_stored_conversations(conversation, monkeypatch, cold):
    from tests.gateway.test_local_resume_compression_child import _cold
    warm = conversation.warm
    conn = _connection(warm)
    opened = await _rpc(conn, 'session.resume', session_id=conversation.owner, omit_messages=True)
    assert 'result' in opened, opened
    detached = await _rpc(conn, 'session.detach', session_id=conversation.owner,
                          subscription_id=opened['result']['subscription_id'], end_reason='cli_close')
    assert detached['result']['detached'] is True, detached
    await conn.close()
    authority = await _cold(conversation) if cold else warm
    conn = _connection(authority)
    try:
        live = await _rpc(conn, 'session.list', include_hidden=True, limit=200)
        assert all(row['id'] != conversation.owner for row in live['result']['sessions']), live
        resumed = await _rpc(conn, 'session.resume', session_id='child-1', omit_messages=True)
        assert 'result' in resumed, resumed
        snapshot = resumed['result']
        assert snapshot['session_id'] == snapshot['stored_session_id'] == conversation.owner
        assert snapshot['messages_omitted'] is True and snapshot['messages'] == []
        assert snapshot['info']['source'] in {'local', 'gui'}
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_canonical_admission_retry_returns_same_receipt_without_model_execution(conversation, monkeypatch):
    authority = conversation.warm
    # Admission and its receipt remain real. Never drain the queue into a model.
    monkeypatch.setattr(authority, '_schedule', lambda _ref: None)
    conn = _connection(authority)
    try:
        resumed = await _rpc(conn, 'session.resume', session_id='child-1', omit_messages=True)
        assert 'result' in resumed, resumed
        params = {'session_id': resumed['result']['session_id'],
                  'text': 'Read the task; this click is not approval. Do not create another task.',
                  'submission_id': '263beef2-8e49-4bb5-a5c2-f3b8dcf3ffae'}
        first = await _rpc(conn, 'prompt.submit', **params)
        assert 'result' in first, first
        retry = await _rpc(conn, 'prompt.submit', **params)
        assert retry['result']['admission_id'] == first['result']['admission_id'], retry
        assert retry['result']['status'] == 'queued'
        receipt = await _rpc(conn, 'prompt.receipt', session_id=params['session_id'],
                             admission_id=first['result']['admission_id'])
        assert receipt['result']['status'] == 'queued', receipt
        assert receipt['result']['ref']['session_id'] == conversation.owner
        assert first['result'] == retry['result']
        assert receipt['result']['admission_id'] == first['result']['admission_id']
        assert not any(live.task for live in authority.sessions.values())
    finally:
        await conn.close()
