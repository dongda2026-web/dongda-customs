CREATE TABLE website_inquiries (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id text NOT NULL CHECK (site_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  source_inquiry_id text NOT NULL CHECK (source_inquiry_id ~ '^DD-[A-Z0-9-]{8,80}$'),
  lead_id uuid NOT NULL,
  schema_version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,site_id,source_inquiry_id),
  UNIQUE(tenant_id,lead_id),
  FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id)
);
ALTER TABLE website_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_inquiries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON website_inquiries
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));

CREATE TABLE website_intake_windows (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL CHECK (attempts>0),
  PRIMARY KEY(tenant_id,site_id)
);
ALTER TABLE website_intake_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_intake_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON website_intake_windows
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
