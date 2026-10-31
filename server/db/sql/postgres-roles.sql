-- Least-privilege logins for the hosted (Postgres / Supabase) Commercia. Run once, as the database owner or a superuser,
-- in an EMPTY database, BEFORE the first start. Replace the {{…}} placeholders; keep the passwords in the host's secret store.
--
--   commercia_migrate  makes and changes tables. Used only by DATABASE_URL_MIGRATE, at start-up.
--   commercia_app      what the running app uses (DATABASE_URL). It can read and write rows and nothing else: it cannot
--                      create, alter, drop or truncate a table, create a role, or touch another database.
--
-- The append-only triggers (ledger, activity, versions, payment_parts, supplier_ledger) stay in force for both.

CREATE ROLE commercia_migrate LOGIN PASSWORD '{{MIGRATE_PASSWORD}}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE commercia_app     LOGIN PASSWORD '{{APP_PASSWORD}}'     NOSUPERUSER NOCREATEDB NOCREATEROLE;

REVOKE ALL ON DATABASE {{DATABASE}} FROM PUBLIC;
GRANT CONNECT ON DATABASE {{DATABASE}} TO commercia_migrate, commercia_app;

-- Nobody but the migrate login may create anything in the schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO commercia_migrate;
GRANT USAGE ON SCHEMA public TO commercia_app;

-- Everything the migrate login creates is readable and writable (rows only) by the app login.
ALTER DEFAULT PRIVILEGES FOR ROLE commercia_migrate IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO commercia_app;
ALTER DEFAULT PRIVILEGES FOR ROLE commercia_migrate IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO commercia_app;
-- (no TRUNCATE, REFERENCES or TRIGGER, and no rights on functions beyond what PUBLIC has)
