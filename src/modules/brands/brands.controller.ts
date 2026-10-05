import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { sendLegalDocsSubmittedEmail, sendLegalDocsDecisionEmail } from "../../utils/email.js";
import { env } from "../../config/env.js";
import bcrypt from "bcryptjs";

export async function applyForBrand(req: Request, res: Response, next: NextFunction) {
  try {
    const { brand_name, contact_email, contact_phone } = req.body;

    const { data: existing, error: existingErr } = await supabase
      .from("brand_applications")
      .select("id, status")
      .or(`contact_email.eq.${contact_email},contact_phone.eq.${contact_phone}`)
      .limit(1);

    if (existingErr) {
      console.error("Supabase pre-check error (brand_applications):", {
        code: existingErr.code,
        message: existingErr.message,
        details: existingErr.details,
        hint: existingErr.hint,
      });
      throw new AppError(500, "APPLICATION_ERROR", "Error while checking existing application");
    }

    if (existing && existing.length > 0) {
      throw new AppError(
        409,
        "APPLICATION_ALREADY_EXISTS",
        "An application already exists with this email or phone"
      );
    }

    const { data, error } = await supabase
      .from("brand_applications")
      .insert({ brand_name, contact_email, contact_phone, status: "pending" })
      .select()
      .single();

    if (error) {
      console.error("Supabase insert error (brand_applications):", {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });

      if (error.code === "23505") {
        throw new AppError(
          409,
          "APPLICATION_ALREADY_EXISTS",
          "An application already exists with this email or phone"
        );
      }

      if (error.code === "42P01") {
        throw new AppError(
          500,
          "BRAND_APPLICATIONS_TABLE_MISSING",
          "Table brand_applications is missing in Supabase"
        );
      }

      if (error.code === "42501") {
        throw new AppError(
          500,
          "SUPABASE_PERMISSION_ERROR",
          "Supabase permission denied on brand_applications"
        );
      }

      throw new AppError(500, "APPLICATION_ERROR", "Failed to submit application");
    }

    sendCreated(res, data, "Application submitted. Our team will contact you soon.");
  } catch (err) {
    next(err);
  }
}

export async function listApplications(req: Request, res: Response, next: NextFunction) {
  try {
    const { status } = req.query;
    let query = supabase
      .from("brand_applications")
      .select("*, brand_documents(*)")
      .order("submitted_at", { ascending: false });

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Error while fetching applications");

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function getApplication(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("brand_applications")
      .select("*, brand_documents(*)")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Application not found");

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function reviewApplication(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;

    const { data: app } = await supabase
      .from("brand_applications")
      .select("*")
      .eq("id", id)
      .single();

    if (!app) throw new AppError(404, "NOT_FOUND", "Application not found");
    if (app.status !== "pending") {
      throw new AppError(400, "ALREADY_REVIEWED", "This application has already been reviewed");
    }

    await supabase
      .from("brand_applications")
      .update({
        status,
        rejection_reason: rejection_reason ?? null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.user!.id,
      })
      .eq("id", id);

    if (status === "approved") {
      const { data: brand } = await supabase
        .from("brands")
        .insert({
          name: app.brand_name,
          is_active: true,
        })
        .select()
        .single();

      const tempPassword = Math.random().toString(36).slice(-10);
      const password_hash = await bcrypt.hash(tempPassword, 12);

      await supabase.from("admins").insert({
        username: app.brand_name.toLowerCase().replace(/\s+/g, "_"),
        email: app.contact_email,
        phone: app.contact_phone,
        password_hash,
        brand_id: brand!.id,
        role: "admin",
        is_active: true,
      });

      sendSuccess(res, { brand, temp_password: tempPassword }, "Brand approved");
    } else {
      sendSuccess(res, { status }, "Application rejected");
    }
  } catch (err) {
    next(err);
  }
}

export async function createBrand(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, description, logo_url, cover_image_url } = req.body;

    const { data: existing } = await supabase
      .from("brands")
      .select("id")
      .eq("name", name)
      .maybeSingle();

    if (existing) throw new AppError(409, "ALREADY_EXISTS", "Une marque avec ce nom existe déjà");

    const { data, error } = await supabase
      .from("brands")
      .insert({ name, description, logo_url, cover_image_url, is_active: true })
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");
    sendCreated(res, data, "Marque créée avec succès");
  } catch (err) {
    next(err);
  }
}

export async function listBrands(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("brands")
      .select("*, admins(username, email), branches(id)")
      .order("created_at", { ascending: false });

    if (error) throw new AppError(500, "FETCH_ERROR", "Error while fetching brands");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function getBrand(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.user?.role === "admin" && req.user.brand_id !== req.params.id) {
      throw new AppError(403, "FORBIDDEN", "Access denied");
    }

    const { data, error } = await supabase
      .from("brands")
      .select("*, branches(*)")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Brand not found");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function updateBrand(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.user?.role === "admin" && req.user.brand_id !== req.params.id) {
      throw new AppError(403, "FORBIDDEN", "Access denied");
    }

    const { data, error } = await supabase
      .from("brands")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Brand not found");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Upload logo marque ────────────────────────────────────────────────────────
export async function uploadBrandLogo(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError(400, "NO_FILE", "Aucun fichier reçu");
    const brandId = req.user?.role === "admin" ? req.user.brand_id! : req.params.id;
    const ext = req.file.originalname.split(".").pop()?.toLowerCase() ?? "jpg";
    const filename = `brands/${brandId}/logo.${ext}`;
    const { error } = await supabase.storage
      .from(env.STORAGE_BUCKET_PRODUCTS ?? "product-images")
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (error) throw new AppError(500, "UPLOAD_ERROR", "Erreur upload logo");
    const { data: urlData } = supabase.storage.from(env.STORAGE_BUCKET_PRODUCTS ?? "product-images").getPublicUrl(filename);
    await supabase.from("brands").update({ logo_url: urlData.publicUrl }).eq("id", brandId);
    sendSuccess(res, { logo_url: urlData.publicUrl });
  } catch (err) { next(err); }
}

// ─── Upload document légal ─────────────────────────────────────────────────────
export async function uploadLegalDoc(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError(400, "NO_FILE", "Aucun fichier reçu");
    const brandId = req.user?.role === "admin" ? req.user.brand_id! : req.params.id;
    const filename = `brands/${brandId}/legal/${Date.now()}_${req.file.originalname}`;
    const { error } = await supabase.storage
      .from(env.STORAGE_BUCKET_PRODUCTS ?? "product-images")
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) throw new AppError(500, "UPLOAD_ERROR", "Erreur upload document");
    const { data: urlData } = supabase.storage.from(env.STORAGE_BUCKET_PRODUCTS ?? "product-images").getPublicUrl(filename);
    // Append to legal_docs array
    const { data: brand } = await supabase.from("brands").select("legal_docs").eq("id", brandId).single();
    const docs = Array.isArray(brand?.legal_docs) ? brand.legal_docs : [];
    docs.push({ url: urlData.publicUrl, name: req.file.originalname, uploaded_at: new Date().toISOString() });
    await supabase.from("brands").update({ legal_docs: docs }).eq("id", brandId);
    sendSuccess(res, { url: urlData.publicUrl });
  } catch (err) { next(err); }
}

// ─── Soumettre les documents légaux au superadmin ──────────────────────────────
export async function submitLegalDocs(req: Request, res: Response, next: NextFunction) {
  try {
    const brandId = req.user?.role === "admin" ? req.user.brand_id! : req.params.id;
    const { data: brand } = await supabase.from("brands").select("name, legal_docs").eq("id", brandId).single();
    if (!brand) throw new AppError(404, "NOT_FOUND", "Marque introuvable");
    const docs = Array.isArray(brand.legal_docs) ? brand.legal_docs : [];
    if (docs.length === 0) throw new AppError(400, "NO_DOCS", "Aucun document uploadé");
    await supabase.from("brands").update({ legal_docs_status: "submitted", legal_docs_submitted_at: new Date().toISOString() }).eq("id", brandId);
    const { data: admin } = await supabase.from("admins").select("email").eq("brand_id", brandId).single();
    await sendLegalDocsSubmittedEmail({ brandName: brand.name, adminEmail: admin?.email ?? "—" });
    sendSuccess(res, { status: "submitted" }, "Documents soumis pour approbation");
  } catch (err) { next(err); }
}

// ─── Approuver / Rejeter les documents légaux (superadmin) ────────────────────
export async function reviewLegalDocs(req: Request, res: Response, next: NextFunction) {
  try {
    const { approved, reason } = req.body as { approved: boolean; reason?: string };
    const { data: brand } = await supabase.from("brands").select("name").eq("id", req.params.id).single();
    if (!brand) throw new AppError(404, "NOT_FOUND", "Marque introuvable");
    const status = approved ? "approved" : "rejected";
    await supabase.from("brands").update({ legal_docs_status: status }).eq("id", req.params.id);
    const { data: admin } = await supabase.from("admins").select("email").eq("brand_id", req.params.id).single();
    if (admin?.email) {
      await sendLegalDocsDecisionEmail({ to: admin.email, brandName: brand.name, approved, reason });
    }
    sendSuccess(res, { status }, approved ? "Documents approuvés" : "Documents refusés");
  } catch (err) { next(err); }
}

export async function suspendBrand(req: Request, res: Response, next: NextFunction) {
  try {
    await supabase.from("brands").update({ is_active: false }).eq("id", req.params.id);
    await supabase.from("admins").update({ is_active: false }).eq("brand_id", req.params.id);
    sendSuccess(res, null, "Brand suspended");
  } catch (err) {
    next(err);
  }
}

// ─── Catalogue superadmin ─────────────────────────────────────────────────────
// Toutes les marques actives avec leurs agences complètes et 4 produits vedettes.

export async function getCatalogue(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: brands, error } = await supabase
      .from("brands")
      .select(`
        id, name, logo_url, description, is_active, created_at,
        branches(id, name, address, city, lat, lng, is_active, is_live, category, image_url, phone)
      `)
      .eq("is_active", true)
      .order("name");

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur catalogue");

    const result = await Promise.all(
      (brands ?? []).map(async (brand) => {
        const branchIds = (brand.branches as Array<{ id: string }>).map((b) => b.id);
        let featured_products: Array<{ id: string; name: string; name_fr: string | null; price: number; image_url: string | null }> = [];

        if (branchIds.length > 0) {
          const { data: products } = await supabase
            .from("products")
            .select("id, name, name_fr, price, image_url")
            .in("branch_id", branchIds)
            .eq("is_hidden", false)
            .order("avg_rating", { ascending: false })
            .limit(4);
          featured_products = products ?? [];
        }

        return { id: brand.id, name: brand.name, logo_url: brand.logo_url, description: brand.description, created_at: brand.created_at, branches: brand.branches, featured_products };
      })
    );

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
