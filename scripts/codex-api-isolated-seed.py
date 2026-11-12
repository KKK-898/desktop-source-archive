"""Seed only a newly created, stopped native smoke-test profile."""
import json
import pathlib
import sqlite3
import sys

p = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
root = pathlib.Path(p['root']).resolve()
home = pathlib.Path(p['home']).resolve()
assert root != home and root in home.parents, 'Refusing non-isolated home'
assert root.name.startswith('gaoge-native-api-smoke-')
auth = json.loads((home / 'auth.json').read_text(encoding='utf-8'))
assert auth == {'auth_mode': 'apikey', 'OPENAI_API_KEY': 'synthetic-isolated-smoke-key'}
databases = list(home.glob('state_*.sqlite'))
assert len(databases) == 1, 'Expected one database initialized by the native app'
database = databases[0].resolve()
assert home in database.parents
connection = sqlite3.connect(database.as_uri() + '?mode=rw', uri=True)
connection.execute('PRAGMA foreign_keys=ON')
with connection:
    assert connection.execute('SELECT count(*) FROM projects').fetchone()[0] == 0
    assert connection.execute('SELECT count(*) FROM threads').fetchone()[0] == 0
    for index, project in enumerate(p['projects']):
        assert root in pathlib.Path(project['root']).resolve().parents
        ms = p['threads'][index]['createdAt'] * 1000
        connection.execute('INSERT INTO projects(id,name,metadata,position,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)',
                           (project['id'], project['name'], '{}', index, ms, ms))
        connection.execute('INSERT INTO project_roots(project_id,position,path) VALUES(?,?,?)',
                           (project['id'], 0, project['root']))
    for thread in p['threads']:
        assert root in pathlib.Path(thread['rolloutPath']).resolve().parents
        assert pathlib.Path(thread['rolloutPath']).is_file()
        values = {
            'id': thread['id'], 'rollout_path': thread['rolloutPath'],
            'created_at': thread['createdAt'], 'updated_at': thread['createdAt'],
            'source': 'vscode', 'model_provider': 'isolated', 'cwd': thread['cwd'], 'title': thread['title'],
            'sandbox_policy': json.dumps({'type': 'read-only'}), 'approval_mode': 'on-request',
            'has_user_event': 1, 'archived': 0, 'cli_version': '0.0.0', 'first_user_message': thread['title'],
            'model': 'gpt-5.5', 'reasoning_effort': 'medium', 'created_at_ms': thread['createdAt'] * 1000,
            'updated_at_ms': thread['createdAt'] * 1000, 'preview': thread['title'],
            'recency_at': thread['createdAt'], 'recency_at_ms': thread['createdAt'] * 1000,
            'history_mode': 'legacy', 'name': thread['title'], 'project_id': thread['projectId'],
        }
        connection.execute('INSERT INTO threads(' + ','.join(values) + ') VALUES(' + ','.join('?' for _ in values) + ')', tuple(values.values()))
    assert connection.execute('SELECT count(*) FROM projects').fetchone()[0] == 4
    assert connection.execute('SELECT count(*) FROM threads WHERE project_id IS NOT NULL AND model_provider=?', ('isolated',)).fetchone()[0] == 4
connection.close()
state_path = home / '.codex-global-state.json'
state = json.loads(state_path.read_text(encoding='utf-8'))
identity = 'local:' + str(home)
state['app-server-projects-migration-by-host'] = {identity: {'version': 1, 'projectsMigrated': True, 'threadAssignmentsReadMigrated': True, 'threadAssignmentsMigrated': True}}
# A native local project has both the app-server row and a desktop catalog.
# Keep the account-owner marker: native API startup must exercise its real reset.
state['local-projects'] = {
    project['id']: {'id': project['id'], 'name': project['name'], 'rootPaths': [project['root']],
                    'createdAt': p['threads'][index]['createdAt'] * 1000,
                    'updatedAt': p['threads'][index]['createdAt'] * 1000}
    for index, project in enumerate(p['projects'])
}
state['app-server-project-id-by-legacy-project-id-by-host'] = {
    identity: {project['id']: project['id'] for project in p['projects']}
}
state['thread-project-assignments'] = {
    thread['id']: {'projectKind': 'local', 'projectId': thread['projectId']} for thread in p['threads']
}
state['thread-project-membership-host-ids'] = {thread['id']: 'local' for thread in p['threads']}
state['projectless-thread-ids'] = []
state['electron-saved-workspace-roots'] = [project['root'] for project in p['projects']]
state['electron-workspace-root-labels'] = {project['root']: project['name'] for project in p['projects']}
state_path.write_text(json.dumps(state), encoding='utf-8')
print(json.dumps({'database': str(database), 'projects': 4, 'threads': 4, 'migrationIdentity': identity, 'syntheticOnly': True}))
