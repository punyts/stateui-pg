-- The directory and ownership (docs/design/statenet-relays.md, "The directory" and "One writer at a time"): the nodes
-- that run the statenet, each heartbeating while it is up, and which owner node holds each namespace, under which epoch
-- and until when. Only owner nodes and aggregates reach the database, so these tables have no row-level security.

CREATE TABLE statenet_node (
    id text PRIMARY KEY,
    role text NOT NULL CHECK (role IN ('owner', 'relay', 'aggregate')),
    region text NOT NULL DEFAULT '',
    endpoint text NOT NULL DEFAULT '',
    public_key text NOT NULL DEFAULT '',
    parent text,
    capacity integer NOT NULL DEFAULT 0,
    protocol integer NOT NULL DEFAULT 1,
    started_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now()
);

-- Changed only by compare-and-swap: each change of owner raises the epoch, and a write from an older epoch is refused
CREATE TABLE namespace_owner (
    address text PRIMARY KEY,
    node text NOT NULL,
    epoch bigint NOT NULL,
    lease_until timestamptz NOT NULL
);
CREATE INDEX namespace_owner_node ON namespace_owner (node);

-- What an authority keeps besides its state and log: the change ids it applied, so a resend is applied once
ALTER TABLE namespace_head ADD COLUMN applied json NOT NULL DEFAULT '[]';
