ALTER TABLE memberships ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE sessions ADD COLUMN membership_version integer NOT NULL DEFAULT 1 CHECK(membership_version > 0);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
-- Authentication must resolve membership before it has a trusted tenant context.
-- Updates, unlike identity lookups, are restricted to the transaction tenant.
CREATE POLICY membership_identity_read ON memberships FOR SELECT USING (true);
CREATE POLICY membership_tenant_update ON memberships FOR UPDATE
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));

CREATE FUNCTION advance_membership_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.active IS DISTINCT FROM OLD.active THEN
    NEW.version := OLD.version + 1;
  ELSIF NEW.version <> OLD.version AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Invalid membership version transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_version_guard BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION advance_membership_version();
