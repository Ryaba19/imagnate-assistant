CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  category_label text NOT NULL,
  stock_mode text NOT NULL CHECK (stock_mode IN ('unit', 'batch')),
  default_purchase_price numeric(12,2) NOT NULL DEFAULT 0,
  default_sale_price numeric(12,2) NOT NULL DEFAULT 0,
  min_stock integer NOT NULL DEFAULT 1,
  source text NOT NULL DEFAULT 'scanner',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_code text NOT NULL UNIQUE,
  imei text,
  serial_number text,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'instock',
  purchase_price numeric(12,2) NOT NULL DEFAULT 0,
  sale_price numeric(12,2) NOT NULL DEFAULT 0,
  location text NOT NULL DEFAULT 'Склад',
  scanned_at timestamptz NOT NULL DEFAULT now(),
  scanned_by text NOT NULL DEFAULT 'system',
  source text NOT NULL DEFAULT 'scanner',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku text,
  barcode text NOT NULL UNIQUE,
  category text NOT NULL,
  qty integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
  status text NOT NULL DEFAULT 'instock',
  purchase_price numeric(12,2) NOT NULL DEFAULT 0,
  sale_price numeric(12,2) NOT NULL DEFAULT 0,
  location text NOT NULL DEFAULT 'Склад',
  scanned_at timestamptz NOT NULL DEFAULT now(),
  scanned_by text NOT NULL DEFAULT 'system',
  source text NOT NULL DEFAULT 'scanner',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text UNIQUE,
  movement_type text NOT NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  unit_id uuid REFERENCES stock_units(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES stock_batches(id) ON DELETE SET NULL,
  code text NOT NULL,
  model text NOT NULL,
  category text NOT NULL,
  qty integer NOT NULL DEFAULT 1,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  location text NOT NULL DEFAULT 'Склад',
  actor text NOT NULL DEFAULT 'system',
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  happened_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id text,
  action text NOT NULL,
  actor text NOT NULL DEFAULT 'system',
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm_fallback ON products(name);
CREATE INDEX IF NOT EXISTS idx_stock_units_product_id ON stock_units(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_units_status ON stock_units(status);
CREATE INDEX IF NOT EXISTS idx_stock_batches_product_id ON stock_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_batches_status ON stock_batches(status);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_id ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_happened_at ON stock_movements(happened_at DESC);
