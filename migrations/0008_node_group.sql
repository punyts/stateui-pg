-- A node's group (docs/design/statenet-network.md, "Groups"): the nodes that run together, on one server or in one
-- stack behind one relay. Nodes of one group link to each other; between groups they go through relays. '' for a
-- node with none, as every node had before.

ALTER TABLE statenet_node ADD COLUMN group_name text NOT NULL DEFAULT '';
