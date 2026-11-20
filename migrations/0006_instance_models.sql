-- An instance is one stored namespace (docs/design/statenet-network.md, "An instance is a stored namespace"): the model
-- of each persona binding moves from beside the binding's row (its value) into the namespace's own state, as the key
-- `models`: { <binding>: <model> }. The binding rows keep their values until the instance is next saved, so a server
-- from before this migration still reads what it wrote, and running this again changes nothing.

INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision, epoch)
SELECT bound.workspace_id, bound.address, 'models', '',
       (SELECT coalesce(max(top.position), 0) + 1 FROM state_node top WHERE top.address = bound.address AND top.parent = ''),
       'value', bound.models, head.revision, head.epoch
  FROM (
        SELECT workspace_id, address, json_object_agg(substr(path, 6), value->>'model' ORDER BY position) AS models
          FROM state_node
         WHERE kind = 'object' AND parent = 'data' AND value->>'model' IS NOT NULL
         GROUP BY workspace_id, address
       ) bound
  JOIN namespace_head head ON head.address = bound.address
ON CONFLICT (address, path) DO NOTHING;
