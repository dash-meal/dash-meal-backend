-- ============================================================
-- DASH MEAL — Migration 022
-- Suppression complète de la fonctionnalité Reels
-- À exécuter dans l'éditeur SQL Supabase
--
-- Fonctionnalité retirée (mobile + admin + backend) : base pas
-- encore assez dimensionnée pour stocker/gérer ce contenu.
-- DESTRUCTIF — supprime définitivement les données existantes.
-- ============================================================

DROP TABLE IF EXISTS reel_comments CASCADE;
DROP TABLE IF EXISTS reel_likes CASCADE;
DROP TABLE IF EXISTS reels CASCADE;
