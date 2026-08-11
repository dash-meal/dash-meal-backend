-- ============================================================
-- Migration 011 — Driver OTP auth + location + PWA support
-- ============================================================

-- ─── 1. Drivers table — ensure all required columns exist ──────────────────
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS pin_hash         TEXT,
  ADD COLUMN IF NOT EXISTS is_online        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS current_lat      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS current_lng      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vehicle_type     TEXT,     -- 'moto' | 'vélo' | 'voiture'
  ADD COLUMN IF NOT EXISTS photo_url        TEXT,
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW();

-- ─── 2. Deliveries table — driver-side ops ─────────────────────────────────
CREATE TABLE IF NOT EXISTS deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID        REFERENCES orders(id) ON DELETE CASCADE,
  driver_id       UUID        REFERENCES drivers(id) ON DELETE SET NULL,
  brand_id        UUID        REFERENCES brands(id) ON DELETE CASCADE,
  branch_id       UUID        REFERENCES branches(id) ON DELETE SET NULL,
  status          TEXT        NOT NULL DEFAULT 'assigned'
                              CHECK (status IN ('assigned','accepted','picked_up','delivered','failed','cancelled')),
  pickup_address  TEXT,
  delivery_address TEXT,
  distance_km     NUMERIC(6,2),
  earnings_amount INTEGER     DEFAULT 0,   -- in CFA francs
  notes           TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 3. OTPs table — unified for user + driver ─────────────────────────────
CREATE TABLE IF NOT EXISTS otps (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT,
  email       TEXT,
  otp         TEXT      NOT NULL,    -- bcrypt hash
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT otps_identifier_check CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_otps_phone ON otps(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email) WHERE email IS NOT NULL;

-- ─── 4. Driver earnings daily view ─────────────────────────────────────────
CREATE OR REPLACE VIEW driver_earnings_daily AS
SELECT
  driver_id,
  DATE(delivered_at)   AS earning_date,
  COUNT(*)             AS deliveries_count,
  SUM(earnings_amount) AS total_earnings
FROM deliveries
WHERE status = 'delivered'
  AND delivered_at IS NOT NULL
GROUP BY driver_id, DATE(delivered_at);

-- ─── 5. Products — promo / flash sale columns ───────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS original_price  INTEGER,
  ADD COLUMN IF NOT EXISTS is_flash_sale   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flash_ends_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_sponsored    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS category        TEXT;

-- ─── 6. Branches — sponsored flag ──────────────────────────────────────────
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS is_sponsored    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sponsored_until TIMESTAMPTZ;

-- ─── 7. Users — email auth support ─────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email           TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS password_hash   TEXT,
  ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── 8. User favorites ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_favorites (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  UUID  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

-- ─── 9. Reels (short-form content) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reels (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    UUID  NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  branch_id   UUID  REFERENCES branches(id) ON DELETE SET NULL,
  product_id  UUID  REFERENCES products(id) ON DELETE SET NULL,
  video_url   TEXT  NOT NULL,
  thumbnail_url TEXT,
  caption     TEXT,
  likes_count  INTEGER NOT NULL DEFAULT 0,
  views_count  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reel_likes (
  reel_id    UUID NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (reel_id, user_id)
);

-- ─── 10. Indexes ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_deliveries_driver_id ON deliveries(driver_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status    ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_order_id  ON deliveries(order_id);
CREATE INDEX IF NOT EXISTS idx_products_category    ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_flash       ON products(is_flash_sale) WHERE is_flash_sale = TRUE;
CREATE INDEX IF NOT EXISTS idx_drivers_is_online    ON drivers(is_online) WHERE is_online = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_favorites_user  ON user_favorites(user_id);

-- ─── 11. Updated_at triggers ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_deliveries_updated_at') THEN
    CREATE TRIGGER trg_deliveries_updated_at
      BEFORE UPDATE ON deliveries
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_drivers_updated_at') THEN
    CREATE TRIGGER trg_drivers_updated_at
      BEFORE UPDATE ON drivers
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ─── 12. Auto-update reel likes count ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_reel_likes_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE reels SET likes_count = likes_count + 1 WHERE id = NEW.reel_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE reels SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.reel_id;
  END IF;
  RETURN NULL;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_reel_likes_count') THEN
    CREATE TRIGGER trg_reel_likes_count
      AFTER INSERT OR DELETE ON reel_likes
      FOR EACH ROW EXECUTE FUNCTION update_reel_likes_count();
  END IF;
END $$;

-- ─── 13. RLS policies ────────────────────────────────────────────────────────
ALTER TABLE deliveries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reel_likes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE otps         ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (backend uses service role key — no policies needed for it)
-- These policies cover the Supabase dashboard / direct queries

CREATE POLICY "service_role_all_deliveries"   ON deliveries      TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_all_favorites"    ON user_favorites  TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_all_reels"        ON reels           TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_all_reel_likes"   ON reel_likes      TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_all_otps"         ON otps            TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ─── 14. Order tracking view ─────────────────────────────────────────────────
CREATE OR REPLACE VIEW order_tracking AS
SELECT
  o.id          AS order_id,
  o.status      AS order_status,
  o.created_at,
  d.id          AS delivery_id,
  d.status      AS delivery_status,
  d.driver_id,
  dr.name       AS driver_name,
  dr.phone      AS driver_phone,
  dr.current_lat,
  dr.current_lng,
  dr.location_updated_at
FROM orders o
LEFT JOIN deliveries d ON d.order_id = o.id
LEFT JOIN drivers    dr ON dr.id = d.driver_id;
