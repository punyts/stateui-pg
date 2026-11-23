-- Requests that wait for the owner (docs/design/statenet-requests.md, R2). A namespace's head keeps its serial, which
-- counts every save, those that take no revision too, so a request is not taken for a save sent again; and its
-- requests, beside the applied ids. pending_request lists the pending ones without values, so a server can list what
-- waits for a person across namespaces without loading them. It is a state table: the namespace's writer keeps it.

ALTER TABLE namespace_head ADD COLUMN serial bigint;
ALTER TABLE namespace_head ADD COLUMN requests json NOT NULL DEFAULT '[]';

CREATE TABLE pending_request (
    address text NOT NULL,
    id text NOT NULL,
    workspace_id uuid NOT NULL,
    owner text NOT NULL,
    subject text NOT NULL,
    at timestamptz NOT NULL,
    until timestamptz NOT NULL,
    PRIMARY KEY (address, id)
);
CREATE INDEX pending_request_owner ON pending_request (owner, at);
CREATE INDEX pending_request_subject ON pending_request (subject, at);

ALTER TABLE pending_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_request FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_rows ON pending_request USING (workspace_id = ANY (app_workspace_ids())) WITH CHECK (workspace_id = ANY (app_workspace_ids()));
