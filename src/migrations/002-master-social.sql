CREATE TABLE partners (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('customer','supplier','both')),
  email text NOT NULL DEFAULT '', contact text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE products (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  code text NOT NULL, name text NOT NULL, unit text NOT NULL,
  price numeric(20,6) NOT NULL DEFAULT 0 CHECK(price >= 0), currency text NOT NULL DEFAULT 'USD',
  spec text NOT NULL DEFAULT '', hs_code text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE TABLE warehouses (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  code text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('domestic','bonded','overseas','fba','transit')),
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE TABLE social_accounts (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  name text NOT NULL, platform text NOT NULL, handle text NOT NULL DEFAULT '',
  connection_state text NOT NULL DEFAULT 'not_connected',
  active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE contents (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  account_id uuid NOT NULL, title text NOT NULL, body text NOT NULL, language text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','review','approved','scheduled','publishing','published','failed','uncertain')),
  scheduled_at timestamptz, published_at timestamptz,
  publication_source text, publication_url text, created_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES social_accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE leads (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  name text NOT NULL, contact text NOT NULL DEFAULT '', need text NOT NULL DEFAULT '',
  account_id uuid, content_id uuid, partner_id uuid, owner_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'new' CHECK(state IN ('new','qualified','won','lost')),
  next_followup_at timestamptz, reason text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES social_accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,content_id) REFERENCES contents(tenant_id,id),
  FOREIGN KEY(tenant_id,partner_id) REFERENCES partners(tenant_id,id),
  FOREIGN KEY(tenant_id,owner_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE lead_followups (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  lead_id uuid NOT NULL, note text NOT NULL, due_at timestamptz, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE content_insights (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  content_id uuid NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0 CHECK(impressions>=0),
  interactions bigint NOT NULL DEFAULT 0 CHECK(interactions>=0),
  clicks bigint NOT NULL DEFAULT 0 CHECK(clicks>=0),
  leads bigint NOT NULL DEFAULT 0 CHECK(leads>=0),
  source text NOT NULL DEFAULT 'manual', created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,content_id) REFERENCES contents(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
  CHECK(period_end >= period_start)
);
CREATE TABLE command_receipts (
  tenant_id uuid NOT NULL REFERENCES tenants(id), key text NOT NULL,
  request_hash text NOT NULL, status integer NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partners','products','warehouses','social_accounts','contents',
    'leads','lead_followups','content_insights','command_receipts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))', t);
    EXECUTE format('CREATE INDEX ON %I (tenant_id,created_at DESC)', t);
  END LOOP;
END $$;
