CREATE TABLE transfers (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  source_warehouse_id uuid NOT NULL, target_warehouse_id uuid NOT NULL, product_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK(quantity>0),
  shipped numeric(20,6) NOT NULL DEFAULT 0 CHECK(shipped>=0 AND shipped<=quantity),
  received numeric(20,6) NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=shipped),
  state text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,source_warehouse_id) REFERENCES warehouses(tenant_id,id),
  FOREIGN KEY(tenant_id,target_warehouse_id) REFERENCES warehouses(tenant_id,id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id),
  CHECK(source_warehouse_id<>target_warehouse_id)
);
CREATE TABLE stocktakes (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, warehouse_id uuid NOT NULL,
  reason text NOT NULL, state text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE stocktake_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id), stocktake_id uuid NOT NULL, product_id uuid NOT NULL,
  baseline_version integer NOT NULL, baseline_quantity numeric(20,6) NOT NULL,
  counted numeric(20,6) NOT NULL CHECK(counted>=0),
  PRIMARY KEY(tenant_id,stocktake_id,product_id),
  FOREIGN KEY(tenant_id,stocktake_id) REFERENCES stocktakes(tenant_id,id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['transfers','stocktakes','stocktake_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))', t);
  END LOOP;
END $$;
