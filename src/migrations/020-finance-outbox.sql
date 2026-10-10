CREATE TABLE finance_outbox (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  document_id uuid NOT NULL, document_version integer NOT NULL,
  event_type text NOT NULL, payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','failed','rejected')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid, lease_until timestamptz, retry_at timestamptz NOT NULL DEFAULT now(),
  remote_id text, error_code text, accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,document_id,document_version),
  FOREIGN KEY(tenant_id,document_id) REFERENCES trade_documents(tenant_id,id)
);
CREATE INDEX finance_outbox_pending ON finance_outbox(tenant_id,retry_at) WHERE state IN ('pending','failed','sending');
CREATE TABLE finance_results (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  event_id uuid NOT NULL, document_id uuid NOT NULL,
  source_version integer NOT NULL, result_version integer NOT NULL,
  financial_record_id text NOT NULL, status text NOT NULL CHECK(status IN ('pending_review','approved','rejected','partially_settled','settled','reversed')),
  currency text NOT NULL, settled_amount numeric(30,6) NOT NULL CHECK(settled_amount>=0),
  payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,financial_record_id,result_version),
  FOREIGN KEY(tenant_id,event_id) REFERENCES finance_outbox(tenant_id,id),
  FOREIGN KEY(tenant_id,document_id) REFERENCES trade_documents(tenant_id,id)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_outbox','finance_results']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))', t);
  END LOOP;
END $$;
