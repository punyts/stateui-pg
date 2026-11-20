-- A place in the statenet is an owner and a path under its `$` (docs/design/statenet-network.md, "`$` is the owner"): a
-- person's state of an app is `$.apps.<appId>` of that person's tree, written `<owner>/apps/<appId>`. This moves every
-- address of the older form, `<owner>/<appId>/user`, to it: the state, its log, its head, who orders it, and the ids of
-- the embeddings of its records (`<address>/<binding>/<key>`). The owner in an address stays what it was; a statenet
-- that issues owner numbers puts them in with a migration of its own. Running this again changes nothing.
--
-- Row-level security holds the tables' owner too (FORCE), and a migration sets no workspace, so the owner is let
-- through for this transaction only and held again before it ends.

ALTER TABLE state_node NO FORCE ROW LEVEL SECURITY;
ALTER TABLE state_change NO FORCE ROW LEVEL SECURITY;
ALTER TABLE namespace_head NO FORCE ROW LEVEL SECURITY;
ALTER TABLE embedding NO FORCE ROW LEVEL SECURITY;

UPDATE state_node SET address = split_part(address, '/', 1) || '/apps/' || split_part(address, '/', 2) WHERE address ~ '^[^/]+/[^/]+/user$';
UPDATE state_change SET address = split_part(address, '/', 1) || '/apps/' || split_part(address, '/', 2) WHERE address ~ '^[^/]+/[^/]+/user$';
UPDATE namespace_head SET address = split_part(address, '/', 1) || '/apps/' || split_part(address, '/', 2) WHERE address ~ '^[^/]+/[^/]+/user$';
UPDATE namespace_owner SET address = split_part(address, '/', 1) || '/apps/' || split_part(address, '/', 2) WHERE address ~ '^[^/]+/[^/]+/user$';
UPDATE embedding SET source_id = regexp_replace(source_id, '^([^/]+)/([^/]+)/user/', '\1/apps/\2/') WHERE source_kind = 'persona-record' AND source_id ~ '^[^/]+/[^/]+/user/';
UPDATE embedding_job SET source_id = regexp_replace(source_id, '^([^/]+)/([^/]+)/user/', '\1/apps/\2/') WHERE source_kind = 'persona-record' AND source_id ~ '^[^/]+/[^/]+/user/';

ALTER TABLE state_node FORCE ROW LEVEL SECURITY;
ALTER TABLE state_change FORCE ROW LEVEL SECURITY;
ALTER TABLE namespace_head FORCE ROW LEVEL SECURITY;
ALTER TABLE embedding FORCE ROW LEVEL SECURITY;
