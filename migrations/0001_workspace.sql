-- A workspace's StateUI storage: its parts, the instances and persona records of its apps, uploaded files and their
-- bytes, and each app's preview errors. Every table carries the workspace id, and row-level security shows a
-- transaction only the rows of the workspaces it set in app.workspace_ids (Database.transaction({ workspaceIds })).
--
-- StateUI's JSON is stored as json, never jsonb: key order is part of a StateUI value (it orders children, options and
-- the other keyed maps), and jsonb would sort the keys.

-- The workspaces the current transaction may see, from app.workspace_ids (a comma-separated list of UUIDs)
CREATE FUNCTION app_workspace_ids() RETURNS uuid[]
    LANGUAGE sql STABLE
    AS $$ SELECT coalesce(string_to_array(nullif(current_setting('app.workspace_ids', true), ''), ',')::uuid[], '{}'::uuid[]) $$;

-- One part: a kind, a name unique within the kind, and its body. The id never changes, so a rename keeps it
CREATE TABLE part (
    workspace_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('apps', 'themes', 'logic', 'models', 'data', 'components', 'patterns')),
    id uuid NOT NULL,
    name text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    body json NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, kind, id),
    CONSTRAINT part_name UNIQUE (workspace_id, kind, name)
);

-- What one persona did in one app: the diff of its state over the app's definition. An empty diff is no row
CREATE TABLE instance (
    workspace_id uuid NOT NULL,
    persona text NOT NULL,
    app_id uuid NOT NULL,
    diff json NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, persona, app_id)
);

-- The records of one persona binding of an app (`scope: 'persona'`), in key order
CREATE TABLE persona_dataset (
    workspace_id uuid NOT NULL,
    persona text NOT NULL,
    app_id uuid NOT NULL,
    binding text NOT NULL,
    model text NOT NULL,
    records json NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, persona, app_id, binding)
);

-- The metadata of a file uploaded to an app
CREATE TABLE app_file (
    workspace_id uuid NOT NULL,
    app_id uuid NOT NULL,
    id uuid NOT NULL,
    name text NOT NULL,
    size bigint NOT NULL CHECK (size >= 0),
    type text NOT NULL,
    sha256 text NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, app_id, id)
);
CREATE INDEX app_file_created ON app_file (workspace_id, app_id, created_at);

-- The bytes of an uploaded file, apart from its metadata so a list never reads them
CREATE TABLE app_file_content (
    workspace_id uuid NOT NULL,
    app_id uuid NOT NULL,
    file_id uuid NOT NULL,
    bytes bytea NOT NULL,
    PRIMARY KEY (workspace_id, app_id, file_id)
);

-- The bounded runtime error log of an app, oldest first, each error with the view load it came from
CREATE TABLE preview_error (
    workspace_id uuid NOT NULL,
    app_id uuid NOT NULL,
    entries json NOT NULL,
    PRIMARY KEY (workspace_id, app_id)
);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['part', 'instance', 'persona_dataset', 'app_file', 'app_file_content', 'preview_error'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY workspace_rows ON %I USING (workspace_id = ANY (app_workspace_ids())) WITH CHECK (workspace_id = ANY (app_workspace_ids()))', table_name);
    END LOOP;
END
$$;
