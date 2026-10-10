CREATE TABLE document_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id), kind text NOT NULL, value bigint NOT NULL,
  PRIMARY KEY(tenant_id,kind)
);
CREATE TABLE trade_documents (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('quote','order','purchase')), number text NOT NULL,
  partner_id uuid NOT NULL, warehouse_id uuid, currency text NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  due_date date, valid_until date, terms text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
  source_id uuid, lead_id uuid, total numeric(30,6) NOT NULL CHECK(total>=0),
  version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,kind,number),
  FOREIGN KEY(tenant_id,partner_id) REFERENCES partners(tenant_id,id),
  FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
  FOREIGN KEY(tenant_id,source_id) REFERENCES trade_documents(tenant_id,id),
  FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE trade_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, document_id uuid NOT NULL,
  product_id uuid NOT NULL, position integer NOT NULL, name text NOT NULL, unit text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK(quantity>0), price numeric(20,6) NOT NULL CHECK(price>=0),
  amount numeric(30,6) NOT NULL CHECK(amount>=0),
  reserved numeric(20,6) NOT NULL DEFAULT 0 CHECK(reserved>=0),
  shipped numeric(20,6) NOT NULL DEFAULT 0 CHECK(shipped>=0),
  received numeric(20,6) NOT NULL DEFAULT 0 CHECK(received>=0),
  cancelled numeric(20,6) NOT NULL DEFAULT 0 CHECK(cancelled>=0),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,document_id,position),
  FOREIGN KEY(tenant_id,document_id) REFERENCES trade_documents(tenant_id,id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
  CHECK(reserved+shipped+cancelled<=quantity), CHECK(received+cancelled<=quantity)
);
CREATE INDEX trade_lines_document_idx ON trade_lines(tenant_id,document_id);
CREATE TABLE trade_versions (
  tenant_id uuid NOT NULL REFERENCES tenants(id), document_id uuid NOT NULL,
  version integer NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,document_id,version),
  FOREIGN KEY(tenant_id,document_id) REFERENCES trade_documents(tenant_id,id)
);
CREATE TABLE procurement_allocations (
  tenant_id uuid NOT NULL REFERENCES tenants(id), purchase_line_id uuid NOT NULL, order_line_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK(quantity>0),
  received numeric(20,6) NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=quantity),
  PRIMARY KEY(tenant_id,purchase_line_id,order_line_id),
  FOREIGN KEY(tenant_id,purchase_line_id) REFERENCES trade_lines(tenant_id,id),
  FOREIGN KEY(tenant_id,order_line_id) REFERENCES trade_lines(tenant_id,id)
);
CREATE TABLE stock_balances (
  tenant_id uuid NOT NULL REFERENCES tenants(id), warehouse_id uuid NOT NULL, product_id uuid NOT NULL,
  on_hand numeric(20,6) NOT NULL DEFAULT 0 CHECK(on_hand>=0),
  reserved numeric(20,6) NOT NULL DEFAULT 0 CHECK(reserved>=0),
  frozen numeric(20,6) NOT NULL DEFAULT 0 CHECK(frozen>=0),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id,warehouse_id,product_id),
  FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
  CHECK(on_hand>=reserved+frozen)
);
CREATE TABLE stock_movements (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  warehouse_id uuid NOT NULL, product_id uuid NOT NULL, kind text NOT NULL,
  delta_on_hand numeric(20,6) NOT NULL DEFAULT 0, delta_reserved numeric(20,6) NOT NULL DEFAULT 0,
  delta_frozen numeric(20,6) NOT NULL DEFAULT 0,
  source_type text NOT NULL, source_id uuid NOT NULL, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,warehouse_id,product_id) REFERENCES stock_balances(tenant_id,warehouse_id,product_id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX stock_movements_rebuild_idx ON stock_movements(tenant_id,warehouse_id,product_id,created_at);
CREATE TABLE fulfilments (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, document_id uuid NOT NULL,
  kind text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,document_id) REFERENCES trade_documents(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE fulfilment_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, fulfilment_id uuid NOT NULL,
  line_id uuid NOT NULL, quantity numeric(20,6) NOT NULL CHECK(quantity>0), source_line_id uuid,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,fulfilment_id) REFERENCES fulfilments(tenant_id,id),
  FOREIGN KEY(tenant_id,line_id) REFERENCES trade_lines(tenant_id,id),
  FOREIGN KEY(tenant_id,source_line_id) REFERENCES fulfilment_lines(tenant_id,id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_counters','trade_documents','trade_lines','trade_versions','procurement_allocations',
    'stock_balances','stock_movements','fulfilments','fulfilment_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))', t);
  END LOOP;
END $$;
