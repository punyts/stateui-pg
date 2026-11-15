-- Vectors of the component library's components and patterns, shared by every workspace, for the catalog searches the
-- keyword index marks weak (docs/design/magnetic-postgres.md, "Four kinds of semantic search"). A set of entries is
-- embedded once per catalog version (the hash of its texts) and model; an older version is removed when a newer one
-- is stored. The table is small, so it has no vector index, and no workspace, so no row-level security.

CREATE TABLE catalog_embedding (
    catalog_version text NOT NULL,
    entry_kind text NOT NULL,
    name text NOT NULL,
    model text NOT NULL,
    embedding vector NOT NULL,
    PRIMARY KEY (catalog_version, entry_kind, model, name),
    CHECK (vector_dims(embedding) > 0)
);
