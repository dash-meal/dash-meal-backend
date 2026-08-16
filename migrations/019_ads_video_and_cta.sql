-- ============================================================
-- DASH MEAL — Migration 019
-- Colonnes manquantes sur ads (video_url, cta_url)
-- À exécuter dans l'éditeur SQL Supabase
--
-- Le backend (ads.controller.ts) et le mobile (app/(tabs)/index.tsx)
-- référencent déjà ces colonnes pour les publicités vidéo — elles
-- n'avaient jamais été ajoutées au schéma, ce qui faisait planter
-- GET /api/v1/ads/public/active en production.
-- ============================================================

ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS video_url TEXT,
  ADD COLUMN IF NOT EXISTS cta_url   TEXT;
