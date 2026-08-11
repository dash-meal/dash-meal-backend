-- ============================================================
-- DASH MEAL — REFONTE COMPLÈTE (SQL consolidé)
-- Inclut toutes les migrations 001→011 + reels + google auth
-- Exécuter une seule fois sur une base fraîche OU
-- exécuter uniquement les blocs manquants sur une base existante
-- ============================================================

-- ─── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── 1. USERS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  phone          TEXT        UNIQUE,
  email          TEXT        UNIQUE,
  password_hash  TEXT,
  google_id      TEXT        UNIQUE,
  is_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN     NOT NULL DEFAULT FALSE,
  avatar_url     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email          TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS password_hash  TEXT,
  ADD COLUMN IF NOT EXISTS google_id      TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS avatar_url     TEXT,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();

-- ─── 2. PENDING REGISTRATIONS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_registrations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT        UNIQUE NOT NULL,
  name          TEXT        NOT NULL,
  email         TEXT,
  password_hash TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 3. OTPs (email + phone) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otps (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT,
  email       TEXT,
  otp         TEXT      NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT otps_identifier_check CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

-- Contraintes UNIQUE pour upsert onConflict
ALTER TABLE otps ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE otps ADD COLUMN IF NOT EXISTS email TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'otps_phone_unique') THEN
    ALTER TABLE otps ADD CONSTRAINT otps_phone_unique UNIQUE (phone);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'otps_email_unique') THEN
    ALTER TABLE otps ADD CONSTRAINT otps_email_unique UNIQUE (email);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_otps_phone ON otps(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email) WHERE email IS NOT NULL;

-- ─── 4. SUPER ADMINS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS super_admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 5. BRANDS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  logo_url     TEXT,
  cover_url    TEXT,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  commission_rate_online   NUMERIC(5,4) DEFAULT 0.02,
  commission_rate_inperson NUMERIC(5,4) DEFAULT 0.015,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 6. BRAND APPLICATIONS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_applications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_name     TEXT NOT NULL,
  contact_name   TEXT NOT NULL,
  contact_email  TEXT NOT NULL,
  contact_phone  TEXT NOT NULL,
  city           TEXT NOT NULL,
  description    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  rejection_note TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 7. ADMINS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  username      TEXT,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','superadmin')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 8. BRANCHES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  address       TEXT NOT NULL,
  city          TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  phone         TEXT,
  email         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  is_sponsored  BOOLEAN NOT NULL DEFAULT FALSE,
  sponsored_until TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS city            TEXT,
  ADD COLUMN IF NOT EXISTS lat             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS email           TEXT,
  ADD COLUMN IF NOT EXISTS is_sponsored    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sponsored_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS username TEXT;

-- ─── 9. CATEGORIES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  name_fr  TEXT NOT NULL,
  name_en  TEXT,
  slug     TEXT NOT NULL,
  icon_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS brand_id  UUID REFERENCES brands(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS name_en   TEXT,
  ADD COLUMN IF NOT EXISTS slug      TEXT,
  ADD COLUMN IF NOT EXISTS icon_url  TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- ─── 10. PRODUCTS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       UUID    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  branch_id      UUID    REFERENCES branches(id) ON DELETE SET NULL,
  category_id    UUID    REFERENCES categories(id) ON DELETE SET NULL,
  name_fr        TEXT    NOT NULL,
  name_en        TEXT,
  description_fr TEXT,
  description_en TEXT,
  price          INTEGER NOT NULL,
  original_price INTEGER,
  unit           TEXT,
  category       TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  is_flash_sale  BOOLEAN NOT NULL DEFAULT FALSE,
  flash_ends_at  TIMESTAMPTZ,
  is_sponsored   BOOLEAN NOT NULL DEFAULT FALSE,
  avg_rating     NUMERIC(3,2) DEFAULT 0,
  image_url      TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS branch_id      UUID REFERENCES branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category_id    UUID REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS name_en        TEXT,
  ADD COLUMN IF NOT EXISTS description_fr TEXT,
  ADD COLUMN IF NOT EXISTS description_en TEXT,
  ADD COLUMN IF NOT EXISTS original_price INTEGER,
  ADD COLUMN IF NOT EXISTS unit           TEXT,
  ADD COLUMN IF NOT EXISTS category       TEXT,
  ADD COLUMN IF NOT EXISTS is_flash_sale  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flash_ends_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_sponsored   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS avg_rating     NUMERIC(3,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS image_url      TEXT,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_products_brand_id    ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_branch_id   ON products(branch_id);
CREATE INDEX IF NOT EXISTS idx_products_category    ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_flash       ON products(is_flash_sale) WHERE is_flash_sale = TRUE;
CREATE INDEX IF NOT EXISTS idx_products_is_active   ON products(is_active);

-- ─── 11. PRODUCT IMAGES ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_images (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE
);

-- ─── 12. ORDERS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID    REFERENCES users(id) ON DELETE SET NULL,
  brand_id         UUID    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  branch_id        UUID    REFERENCES branches(id) ON DELETE SET NULL,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','confirmed','preparing','ready','delivering','delivered','cancelled')),
  type             TEXT    NOT NULL DEFAULT 'delivery' CHECK (type IN ('delivery','pickup')),
  total_amount     INTEGER NOT NULL,
  delivery_fee     INTEGER NOT NULL DEFAULT 0,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  delivery_address TEXT,
  delivery_lat     DOUBLE PRECISION,
  delivery_lng     DOUBLE PRECISION,
  payment_method   TEXT,
  payment_status   TEXT    NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded')),
  payment_reference TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS brand_id           UUID REFERENCES brands(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS branch_id          UUID REFERENCES branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS type               TEXT DEFAULT 'delivery',
  ADD COLUMN IF NOT EXISTS delivery_fee       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_amount  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_address   TEXT,
  ADD COLUMN IF NOT EXISTS delivery_lat       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS delivery_lng       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS payment_method     TEXT,
  ADD COLUMN IF NOT EXISTS payment_status     TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_reference  TEXT,
  ADD COLUMN IF NOT EXISTS notes              TEXT,
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW();

-- ─── 13. ORDER ITEMS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID    REFERENCES products(id) ON DELETE SET NULL,
  name_fr    TEXT    NOT NULL,
  name_en    TEXT,
  unit_price INTEGER NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 1,
  subtotal   INTEGER NOT NULL
);

-- ─── 14. DRIVERS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drivers (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            UUID    REFERENCES brands(id) ON DELETE CASCADE,
  branch_id           UUID    REFERENCES branches(id) ON DELETE SET NULL,
  name                TEXT    NOT NULL,
  phone               TEXT    UNIQUE NOT NULL,
  pin_hash            TEXT,
  vehicle_type        TEXT,
  photo_url           TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  is_online           BOOLEAN NOT NULL DEFAULT FALSE,
  current_lat         DOUBLE PRECISION,
  current_lng         DOUBLE PRECISION,
  location_updated_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS brand_id            UUID REFERENCES brands(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS branch_id           UUID REFERENCES branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pin_hash            TEXT,
  ADD COLUMN IF NOT EXISTS is_online           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS current_lat         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS current_lng         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vehicle_type        TEXT,
  ADD COLUMN IF NOT EXISTS photo_url           TEXT,
  ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_drivers_is_online ON drivers(is_online) WHERE is_online = TRUE;

-- ─── 15. DELIVERIES ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID REFERENCES orders(id) ON DELETE CASCADE,
  driver_id        UUID REFERENCES drivers(id) ON DELETE SET NULL,
  brand_id         UUID REFERENCES brands(id) ON DELETE CASCADE,
  branch_id        UUID REFERENCES branches(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'assigned'
                   CHECK (status IN ('assigned','accepted','picked_up','delivered','failed','cancelled')),
  pickup_address   TEXT,
  delivery_address TEXT,
  distance_km      NUMERIC(6,2),
  earnings_amount  INTEGER DEFAULT 0,
  notes            TEXT,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_driver_id ON deliveries(driver_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status    ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_order_id  ON deliveries(order_id);

-- ─── 16. FAVORITES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS favorites (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);

-- ─── 17. REELS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reels (
  id            UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      UUID  NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  branch_id     UUID  REFERENCES branches(id) ON DELETE SET NULL,
  product_id    UUID  REFERENCES products(id) ON DELETE SET NULL,
  video_url     TEXT  NOT NULL,
  thumbnail_url TEXT,
  caption       TEXT  NOT NULL DEFAULT '',
  likes_count   INTEGER NOT NULL DEFAULT 0,
  views_count   INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reels_brand_id   ON reels(brand_id);
CREATE INDEX IF NOT EXISTS idx_reels_is_active  ON reels(is_active) WHERE is_active = TRUE;

-- ─── 18. REEL LIKES ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reel_likes (
  reel_id    UUID NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (reel_id, user_id)
);

-- ─── 19. REEL COMMENTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reel_comments (
  id              UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  reel_id         UUID  NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  user_id         UUID  REFERENCES users(id) ON DELETE SET NULL,
  brand_id        UUID  REFERENCES brands(id) ON DELETE SET NULL,
  content         TEXT  NOT NULL,
  parent_id       UUID  REFERENCES reel_comments(id) ON DELETE CASCADE,
  is_brand_reply  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reel_comments_reel_id   ON reel_comments(reel_id);
CREATE INDEX IF NOT EXISTS idx_reel_comments_parent_id ON reel_comments(parent_id);

-- ─── 20. PAYMENTS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID REFERENCES orders(id) ON DELETE CASCADE,
  brand_id         UUID REFERENCES brands(id) ON DELETE CASCADE,
  amount           INTEGER NOT NULL,
  method           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed')),
  campay_reference TEXT UNIQUE,
  operator         TEXT,
  phone            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS brand_id         UUID REFERENCES brands(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS campay_reference TEXT,
  ADD COLUMN IF NOT EXISTS operator         TEXT,
  ADD COLUMN IF NOT EXISTS phone            TEXT,
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW();

-- ─── 21. NOTIFICATIONS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  driver_id  UUID REFERENCES drivers(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'info',
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  data       JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add driver_id to pre-existing notifications table (CREATE TABLE IF NOT EXISTS skips if table exists)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_user_id   ON notifications(user_id)   WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_driver_id ON notifications(driver_id) WHERE driver_id IS NOT NULL;

-- ─── 22. CHAT MESSAGES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id  UUID NOT NULL,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('user','admin','driver')),
  content    TEXT NOT NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_order_id ON chat_messages(order_id);

-- ─── 23. ADS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          UUID    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  title             TEXT    NOT NULL,
  image_url         TEXT    NOT NULL,
  target_count      INTEGER NOT NULL,
  amount_paid       INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','active','expired','rejected')),
  impressions_count INTEGER NOT NULL DEFAULT 0,
  rejection_reason  TEXT,
  activated_at      TIMESTAMPTZ,
  campay_reference  TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS impressions_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rejection_reason  TEXT,
  ADD COLUMN IF NOT EXISTS activated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS campay_reference  TEXT;

-- ─── 24. PROMOTIONS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promotions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('fixed','percent')),
  value       INTEGER NOT NULL,
  min_amount  INTEGER DEFAULT 0,
  max_uses    INTEGER,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS min_amount  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_uses    INTEGER,
  ADD COLUMN IF NOT EXISTS used_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_active   BOOLEAN NOT NULL DEFAULT TRUE;

-- ─── 25. LOYALTY ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_points (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id   UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  points     INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, brand_id)
);

-- Add columns to pre-existing deliveries table (CREATE TABLE IF NOT EXISTS skips if table exists)
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS brand_id         UUID REFERENCES brands(id) ON DELETE CASCADE;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS branch_id        UUID REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS earnings_amount  INTEGER DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS distance_km      NUMERIC(6,2);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS pickup_address   TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivered_at     TIMESTAMPTZ;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS notes            TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW();

-- ─── 26. DRIVER EARNINGS VIEW ────────────────────────────────────────────────
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

-- ─── 27. ORDER TRACKING VIEW ─────────────────────────────────────────────────
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
LEFT JOIN deliveries d  ON d.order_id = o.id
LEFT JOIN drivers    dr ON dr.id = d.driver_id;

-- ─── 28. TRIGGERS ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Apply updated_at trigger to all relevant tables
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['users','brands','branches','products','orders','drivers','deliveries','payments','reels'] LOOP
    EXECUTE format('
      DROP TRIGGER IF EXISTS trg_%s_updated_at ON %s;
      CREATE TRIGGER trg_%s_updated_at
        BEFORE UPDATE ON %s
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    ', tbl, tbl, tbl, tbl);
  END LOOP;
END $$;

-- Reel likes counter
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

DROP TRIGGER IF EXISTS trg_reel_likes_count ON reel_likes;
CREATE TRIGGER trg_reel_likes_count
  AFTER INSERT OR DELETE ON reel_likes
  FOR EACH ROW EXECUTE FUNCTION update_reel_likes_count();

-- ─── 29. ROW LEVEL SECURITY ──────────────────────────────────────────────────
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorites         ENABLE ROW LEVEL SECURITY;
ALTER TABLE reels             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reel_likes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reel_comments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE otps              ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers           ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS entirely (backend uses service_role key)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'users','orders','order_items','favorites','reels','reel_likes',
    'reel_comments','otps','notifications','deliveries','drivers',
    'products','product_images','brands','branches','admins',
    'payments','promotions','ads','loyalty_points','chat_messages'
  ] LOOP
    EXECUTE format('
      DROP POLICY IF EXISTS service_role_all_%s ON %s;
      CREATE POLICY service_role_all_%s ON %s TO service_role USING (TRUE) WITH CHECK (TRUE);
    ', tbl, tbl, tbl, tbl);
  END LOOP;
END $$;

-- ─── 30. INDEXES (remaining) ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_user_id     ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_brand_id    ON orders(brand_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_chat_created_at    ON chat_messages(created_at);
