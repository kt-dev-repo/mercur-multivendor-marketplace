-- Create the role the integration test harness expects.
--
-- integration-tests/.env.test hardcodes postgres:postgres@localhost:5432, and
-- @medusajs/test-utils builds its connection from the DB_* vars rather than
-- DATABASE_URL, so the credentials cannot be pointed elsewhere without editing
-- that upstream-tracked file. The harness also creates and drops databases per
-- run, so the role needs SUPERUSER and CREATEDB.
--
-- Because POSTGRES_USER is `mercur`, the image does not create a `postgres`
-- role of its own — this adds it. Runs once, on first initialisation of an
-- empty data directory.
--
-- Local development only. Never ship this role to a deployed database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres LOGIN SUPERUSER CREATEDB PASSWORD 'postgres';
  END IF;
END
$$;
