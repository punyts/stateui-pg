-- State by address, path by path (docs/design/statenet-relays.md, "Storage in Postgres"): a namespace lives at
-- `<ownerId>/<appId>/<scope>`, and each of its stored subtrees is a row of state_node: one per top-level key, and one
-- per record of a data binding. A change rewrites only the rows under its path; state_change keeps what changed, for
-- catch-up and audit; namespace_head says how far each namespace has got. The instances and persona records of
-- 0001 move here, a persona's state of an app being the namespace `<persona>/<appId>/user` (the workspace's own id for
-- its default persona), and their tables go.
--
-- Paths are the state path without `$.`, dotted (a record key holds no dot). Row-level security is by the workspace
-- the app is in, like every workspace table: the owner in the address says whose the state is, the workspace who may
-- reach it.

CREATE TABLE state_node (
    workspace_id uuid NOT NULL,
    address text NOT NULL,
    path text NOT NULL,
    -- The path of the object row this row is a child of; '' for a top-level key
    parent text NOT NULL,
    -- The order among the rows of one parent, which is the key order StateUI shows
    position integer NOT NULL,
    -- 'value': the whole subtree is the value; 'object': an object whose keys are the child rows, and value is what
    -- the store keeps about it (a persona binding's model)
    kind text NOT NULL CHECK (kind IN ('value', 'object')),
    value json,
    revision bigint NOT NULL,
    epoch bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (address, path)
);
CREATE INDEX state_node_workspace ON state_node (workspace_id, address);
CREATE INDEX state_node_parent ON state_node (address, parent, position);

CREATE TABLE state_change (
    workspace_id uuid NOT NULL,
    address text NOT NULL,
    revision bigint NOT NULL,
    seq integer NOT NULL,
    epoch bigint NOT NULL DEFAULT 0,
    id text,
    path text NOT NULL,
    op text NOT NULL CHECK (op IN ('set', 'delete')),
    value json,
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (address, revision, seq)
);
CREATE INDEX state_change_workspace ON state_change (workspace_id, at);

CREATE TABLE namespace_head (
    address text PRIMARY KEY,
    workspace_id uuid NOT NULL,
    revision bigint NOT NULL DEFAULT 0,
    durable_revision bigint NOT NULL DEFAULT 0,
    epoch bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX namespace_head_workspace ON namespace_head (workspace_id);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['state_node', 'state_change', 'namespace_head'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY workspace_rows ON %I USING (workspace_id = ANY (app_workspace_ids())) WITH CHECK (workspace_id = ANY (app_workspace_ids()))', table_name);
    END LOOP;
END
$$;

-- The instances: each top-level key of a diff becomes a row, in the diff's key order
INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision)
SELECT i.workspace_id, CASE WHEN i.persona = 'default' THEN i.workspace_id::text ELSE i.persona END || '/' || i.app_id::text || '/user',
       entry.key, '', entry.ordinality::integer, 'value', entry.value, 1
  FROM instance i
 CROSS JOIN LATERAL json_each(CASE WHEN json_typeof(i.diff) = 'object' THEN i.diff ELSE '{}'::json END) WITH ORDINALITY AS entry(key, value, ordinality)
 WHERE entry.key <> 'data';

-- The persona records: a `data` object, an object per binding with its model, and a row per record in key order
INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision)
SELECT DISTINCT ON (address) workspace_id, address, 'data', '', 0, 'object', NULL::json, 1
  FROM (SELECT workspace_id, CASE WHEN persona = 'default' THEN workspace_id::text ELSE persona END || '/' || app_id::text || '/user' AS address FROM persona_dataset) p;

INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision)
SELECT workspace_id, address, 'data.' || binding, 'data', (row_number() OVER (PARTITION BY address ORDER BY binding))::integer, 'object', json_build_object('model', model), 1
  FROM (SELECT workspace_id, CASE WHEN persona = 'default' THEN workspace_id::text ELSE persona END || '/' || app_id::text || '/user' AS address, binding, model FROM persona_dataset) p;

INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision)
SELECT p.workspace_id, CASE WHEN p.persona = 'default' THEN p.workspace_id::text ELSE p.persona END || '/' || p.app_id::text || '/user',
       'data.' || p.binding || '.' || entry.key, 'data.' || p.binding, entry.ordinality::integer, 'value', entry.value, 1
  FROM persona_dataset p
 CROSS JOIN LATERAL json_each(CASE WHEN json_typeof(p.records) = 'object' THEN p.records ELSE '{}'::json END) WITH ORDINALITY AS entry(key, value, ordinality);

-- Each namespace's head keeps when it last changed, which retention reads
INSERT INTO namespace_head (address, workspace_id, revision, durable_revision, updated_at)
SELECT address, workspace_id, 1, 1, max(updated_at)
  FROM (SELECT workspace_id, CASE WHEN persona = 'default' THEN workspace_id::text ELSE persona END || '/' || app_id::text || '/user' AS address, updated_at FROM instance
        UNION ALL
        SELECT workspace_id, CASE WHEN persona = 'default' THEN workspace_id::text ELSE persona END || '/' || app_id::text || '/user', updated_at FROM persona_dataset) s
 GROUP BY address, workspace_id;

DROP TABLE instance;
DROP TABLE persona_dataset;
