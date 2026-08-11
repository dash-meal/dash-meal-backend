-- ============================================================
-- Migration 010 — Mobile redesign + Driver PWA
-- Dash Meal — 2026-05-11
-- ============================================================

-- ─── 1. Email auth for mobile users ─────────────────────────────────────────

-- Add email to mobile users table (if table is named "users")
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email               TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS email_verified      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS avatar_url          TEXT,
  ADD COLUMN IF NOT EXISTS preferred_language  TEXT NOT NULL DEFAULT 'fr';

-- Support email-based OTPs (extend existing otps table or create if not exists)
CREATE TABLE IF NOT EXISTS otps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier  TEXT NOT NULL,   -- phone number OR email address
  type        TEXT NOT NULL DEFAULT 'phone', -- 'phone' | 'email'
  otp         TEXT NOT NULL,   -- bcrypt-hashed
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replace old phone-only unique constraint with identifier+type
CREATE UNIQUE INDEX IF NOT EXISTS otps_identifier_type_idx ON otps (identifier, type);
CREATE INDEX IF NOT EXISTS otps_expires_idx ON otps (expires_at);

-- ─── 2. Sponsored branches ───────────────────────────────────────────────────

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS is_sponsored       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sponsor_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sponsor_priority   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cover_url          TEXT,
  ADD COLUMN IF NOT EXISTS distance_m         INTEGER,    -- populated by background job
  ADD COLUMN IF NOT EXISTS rating             NUMERIC(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_count       INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS branches_sponsored_idx ON branches (is_sponsored, sponsor_priority DESC)
  WHERE is_sponsored = true;

-- ─── 3. Flash sales & promos on products ─────────────────────────────────────

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS original_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS discount_pct   SMALLINT,          -- 0-100
  ADD COLUMN IF NOT EXISTS flash_ends_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_promo       BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS products_flash_idx ON products (flash_ends_at)
  WHERE flash_ends_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS products_promo_idx ON products (is_promo)
  WHERE is_promo = true;

-- ─── 4. Reels ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID REFERENCES branches(id) ON DELETE CASCADE,
  product_id    UUID REFERENCES products(id) ON DELETE SET NULL,
  caption       TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT,
  video_url     TEXT,
  likes         INTEGER NOT NULL DEFAULT 0,
  comments      INTEGER NOT NULL DEFAULT 0,
  views         INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reels_branch_idx    ON reels (branch_id);
CREATE INDEX IF NOT EXISTS reels_active_idx    ON reels (is_active, created_at DESC)
  WHERE is_active = true;

-- Reel likes (user ↔ reel)
CREATE TABLE IF NOT EXISTS reel_likes (
  reel_id    UUID REFERENCES reels(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reel_id, user_id)
);

-- Reel comments
CREATE TABLE IF NOT EXISTS reel_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reel_id    UUID REFERENCES reels(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reel_comments_reel_idx ON reel_comments (reel_id, created_at DESC);

-- ─── 5. Drivers ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS drivers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         UUID REFERENCES brands(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL UNIQUE,
  avatar_url       TEXT,
  vehicle_type     TEXT NOT NULL DEFAULT 'moto', -- 'moto' | 'car' | 'bicycle'
  vehicle_plate    TEXT,
  license_url      TEXT,          -- KYC doc
  id_card_url      TEXT,          -- KYC doc
  kyc_status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  is_available     BOOLEAN NOT NULL DEFAULT false,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  rating           NUMERIC(3,2) NOT NULL DEFAULT 5,
  total_deliveries INTEGER NOT NULL DEFAULT 0,
  total_earnings   NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- JWT tokens (hashed refresh stored server-side)
  refresh_token    TEXT,
  last_seen_at     TIMESTAMPTZ,
  -- GPS
  last_lat         DOUBLE PRECISION,
  last_lng         DOUBLE PRECISION,
  last_location_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drivers_brand_idx     ON drivers (brand_id);
CREATE INDEX IF NOT EXISTS drivers_available_idx ON drivers (brand_id, is_available)
  WHERE is_available = true AND is_active = true;

-- Driver OTPs (phone-based, separate table for clarity)
CREATE TABLE IF NOT EXISTS driver_otps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      TEXT NOT NULL,
  otp        TEXT NOT NULL,  -- bcrypt-hashed
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_otps_phone_idx ON driver_otps (phone);

-- ─── 6. Deliveries ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID REFERENCES orders(id) ON DELETE CASCADE UNIQUE,
  driver_id       UUID REFERENCES drivers(id) ON DELETE SET NULL,
  brand_id        UUID REFERENCES brands(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'accepted' | 'picking_up' | 'delivering' | 'delivered' | 'cancelled'
  delivery_address TEXT,
  delivery_lat    DOUBLE PRECISION,
  delivery_lng    DOUBLE PRECISION,
  distance_km     NUMERIC(6,2),
  commission      NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Timestamps per step
  accepted_at     TIMESTAMPTZ,
  picking_up_at   TIMESTAMPTZ,
  delivering_at   TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deliveries_driver_idx  ON deliveries (driver_id, status);
CREATE INDEX IF NOT EXISTS deliveries_brand_idx   ON deliveries (brand_id, status);
CREATE INDEX IF NOT EXISTS deliveries_order_idx   ON deliveries (order_id);

-- ─── 7. Driver earnings view ─────────────────────────────────────────────────

CREATE OR REPLACE VIEW driver_earnings_daily AS
SELECT
  d.driver_id,
  DATE(d.delivered_at) AS delivery_date,
  COUNT(*)             AS delivery_count,
  SUM(d.commission)    AS total_commission,
  AVG(d.commission)    AS avg_commission,
  SUM(d.distance_km)   AS total_distance_km
FROM deliveries d
WHERE d.status = 'delivered'
  AND d.delivered_at IS NOT NULL
GROUP BY d.driver_id, DATE(d.delivered_at);

-- ─── 8. Tracking (real-time driver location) ─────────────────────────────────

-- This replaces the /tracking/delivery/:order_id endpoint data
-- The backend updates driver location every ~10s via PATCH /driver/location
CREATE OR REPLACE VIEW order_tracking AS
SELECT
  o.id           AS order_id,
  o.status       AS order_status,
  dr.id          AS driver_id,
  dr.name        AS driver_name,
  dr.phone       AS driver_phone,
  dr.last_lat    AS lat,
  dr.last_lng    AS lng,
  dv.distance_km,
  dv.accepted_at,
  dv.delivering_at,
  -- ETA: rough estimate = distance_km * 3 minutes per km
  CASE WHEN dr.last_lat IS NOT NULL
    THEN GREATEST(1, ROUND(dv.distance_km * 3)::INTEGER)
    ELSE NULL
  END AS estimated_minutes
FROM orders o
LEFT JOIN deliveries dv ON dv.order_id = o.id
LEFT JOIN drivers dr    ON dr.id = dv.driver_id;

-- ─── 9. Update orders table for delivery fields ───────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_lat     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS delivery_lng     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS customer_phone   TEXT,
  ADD COLUMN IF NOT EXISTS customer_name    TEXT,
  ADD COLUMN IF NOT EXISTS notes            TEXT,
  ADD COLUMN IF NOT EXISTS order_type       TEXT NOT NULL DEFAULT 'delivery';
  -- 'delivery' | 'collect'

-- ─── 10. RLS policies ────────────────────────────────────────────────────────

-- Drivers can only read/update their own record
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS drivers_self_read ON drivers
  FOR SELECT USING (id = current_setting('app.driver_id', true)::UUID);

CREATE POLICY IF NOT EXISTS drivers_self_update ON drivers
  FOR UPDATE USING (id = current_setting('app.driver_id', true)::UUID);

-- Deliveries: drivers see only their own
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS deliveries_driver_read ON deliveries
  FOR SELECT USING (
    driver_id = current_setting('app.driver_id', true)::UUID
    OR brand_id IN (
      SELECT brand_id FROM admins WHERE id = current_setting('app.admin_id', true)::UUID
    )
  );

-- ─── 11. Triggers ────────────────────────────────────────────────────────────

-- Auto-update updated_at on drivers
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER drivers_updated_at
    BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

DO $$ BEGIN
  CREATE TRIGGER deliveries_updated_at
    BEFORE UPDATE ON deliveries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

DO $$ BEGIN
  CREATE TRIGGER reels_updated_at
    BEFORE UPDATE ON reels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

-- Sync reel likes count
CREATE OR REPLACE FUNCTION sync_reel_likes_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE reels SET likes = likes + 1 WHERE id = NEW.reel_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE reels SET likes = GREATEST(0, likes - 1) WHERE id = OLD.reel_id;
  END IF;
  RETURN NULL;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER reel_likes_count_trigger
    AFTER INSERT OR DELETE ON reel_likes
    FOR EACH ROW EXECUTE FUNCTION sync_reel_likes_count();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;

-- Sync driver totals when delivery is marked delivered
CREATE OR REPLACE FUNCTION sync_driver_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'delivered' AND OLD.status != 'delivered' THEN
    UPDATE drivers
    SET total_deliveries = total_deliveries + 1,
        total_earnings   = total_earnings + NEW.commission
    WHERE id = NEW.driver_id;
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER delivery_driver_totals_trigger
    AFTER UPDATE OF status ON deliveries
    FOR EACH ROW EXECUTE FUNCTION sync_driver_totals();
EXCEPTION WHEN duplicate_object THEN NULL; END; $$;
