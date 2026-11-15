-- Vectors for semantic search, and the queue that makes them. Every vector names the model that made it: a search
-- compares only vectors of its own model (docs/design/magnetic-postgres.md, "Every stored vector names its model").
-- The column has no fixed size, so each model gets its own HNSW index over a cast to its size, partial on the model
-- (ensureEmbeddingIndex), and searches use the same cast and filter.

CREATE TABLE embedding (
    workspace_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    -- The field of a record, for the records of an app's data; '' for a whole source (a part, a chat entry)
    field text NOT NULL DEFAULT '',
    -- Whose this is within the workspace, for a person's own sources (their chats); '' for everyone's
    owner text NOT NULL DEFAULT '',
    model text NOT NULL,
    embedding vector NOT NULL,
    source_hash text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, source_kind, source_id, field, model),
    CHECK (vector_dims(embedding) > 0)
);

-- What is waiting to be embedded. A write adds a job in its own transaction; the worker takes them with SKIP LOCKED
CREATE TABLE embedding_job (
    id bigserial PRIMARY KEY,
    workspace_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    field text NOT NULL DEFAULT '',
    queued_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX embedding_job_source ON embedding_job (workspace_id, source_kind, source_id, field);

ALTER TABLE embedding ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_rows ON embedding USING (workspace_id = ANY (app_workspace_ids())) WITH CHECK (workspace_id = ANY (app_workspace_ids()));
