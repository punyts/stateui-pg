-- Who may write which rows of the directory (docs/design/statenet-relay-directory.md): row-level security on
-- statenet_node, with one policy that lets every role see and write every row as before. grantAggregateRole adds
-- restrictive policies for the aggregate's role, so it may insert, change and delete only the rows of relays. The
-- table's owner is not held (no FORCE), as the migrations run as it.

ALTER TABLE statenet_node ENABLE ROW LEVEL SECURITY;
CREATE POLICY every_node ON statenet_node USING (true) WITH CHECK (true);
