CREATE TABLE shipment_document_sources (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  fulfilment_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,fulfilment_id),
  FOREIGN KEY(tenant_id,fulfilment_id) REFERENCES fulfilments(tenant_id,id),
  FOREIGN KEY(tenant_id,document_id,document_version) REFERENCES trade_versions(tenant_id,document_id,version)
);
CREATE TABLE issued_documents (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  number text NOT NULL,
  document_id uuid NOT NULL,
  document_version integer NOT NULL,
  fulfilment_id uuid,
  kind text NOT NULL CHECK(kind IN ('invoice','packing_list','purchase_order')),
  template_version text NOT NULL,
  snapshot jsonb NOT NULL,
  html text NOT NULL,
  sha256 text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,number),
  FOREIGN KEY(tenant_id,document_id,document_version) REFERENCES trade_versions(tenant_id,document_id,version),
  FOREIGN KEY(tenant_id,fulfilment_id) REFERENCES shipment_document_sources(tenant_id,fulfilment_id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
  CHECK((kind='purchase_order') = (fulfilment_id IS NULL))
);
CREATE INDEX issued_documents_source_idx ON issued_documents(tenant_id,document_id,created_at);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shipment_document_sources','issued_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))',t);
  END LOOP;
END $$;
