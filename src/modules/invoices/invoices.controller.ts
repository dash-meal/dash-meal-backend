import type { Request, Response, NextFunction } from "express";
import PDFDocument from "pdfkit";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { env } from "../../config/env.js";

export async function generateInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const { orderId } = req.params;

    const { data: order } = await supabase
      .from("orders")
      .select(`
        *,
        users(name, phone),
        branches(name, address, brands(name, logo_url)),
        order_items(quantity, unit_price, subtotal, products(name_fr, name_en)),
        payments(method, amount, status)
      `)
      .eq("id", orderId)
      .single();

    if (!order) throw new AppError(404, "NOT_FOUND", "Commande introuvable");

    // Vérifier accès
    if (req.user?.role === "user" && order.user_id !== req.user.id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    // Vérifier si une facture existe déjà
    const { data: existing } = await supabase
      .from("invoices")
      .select("pdf_url")
      .eq("order_id", orderId)
      .single();

    if (existing) {
      sendSuccess(res, { pdf_url: existing.pdf_url });
      return;
    }

    // Générer le PDF
    const pdfBuffer = await buildInvoicePdf(order);

    // Uploader sur Supabase Storage
    const fileName = `invoice-${orderId}-${Date.now()}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from(env.STORAGE_BUCKET_INVOICES)
      .upload(fileName, pdfBuffer, { contentType: "application/pdf" });

    if (uploadError) throw new AppError(500, "PDF_UPLOAD_ERROR", "Erreur d'upload du PDF");

    const { data: { publicUrl } } = supabase.storage
      .from(env.STORAGE_BUCKET_INVOICES)
      .getPublicUrl(fileName);

    await supabase.from("invoices").insert({
      order_id: orderId,
      pdf_url: publicUrl,
    });

    sendSuccess(res, { pdf_url: publicUrl }, "Facture générée");
  } catch (err) {
    next(err);
  }
}

export async function getInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("invoices")
      .select("*")
      .eq("order_id", req.params.orderId)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Facture introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Génération PDF ───────────────────────────────────────────────────────────

async function buildInvoicePdf(order: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const branch = order.branches as Record<string, unknown>;
    const brand = branch.brands as Record<string, string>;
    const user = order.users as Record<string, string>;
    const items = order.order_items as Array<Record<string, unknown>>;

    // En-tête
    doc.fontSize(20).font("Helvetica-Bold").text("DASH MEAL", 50, 50);
    doc.fontSize(10).font("Helvetica").text("Facture / Invoice", 50, 75);

    // Infos commande
    doc.fontSize(12).font("Helvetica-Bold").text(`Commande #${(order.id as string).slice(0, 8).toUpperCase()}`, 50, 110);
    doc.fontSize(10).font("Helvetica")
      .text(`Date : ${new Date(order.created_at as string).toLocaleDateString("fr-FR")}`, 50, 128)
      .text(`Magasin : ${brand.name} — ${branch.name}`, 50, 143)
      .text(`Client : ${user.name} (${user.phone})`, 50, 158);

    // Tableau des articles
    doc.moveTo(50, 185).lineTo(545, 185).stroke();
    doc.fontSize(10).font("Helvetica-Bold")
      .text("Produit", 50, 192)
      .text("Qté", 350, 192)
      .text("P.U.", 400, 192)
      .text("Total", 470, 192);
    doc.moveTo(50, 207).lineTo(545, 207).stroke();

    let y = 215;
    for (const item of items) {
      const product = item.products as Record<string, string>;
      doc.fontSize(9).font("Helvetica")
        .text(product.name_fr, 50, y, { width: 290 })
        .text(String(item.quantity), 350, y)
        .text(`${item.unit_price} FCFA`, 400, y)
        .text(`${item.subtotal} FCFA`, 470, y);
      y += 20;
    }

    doc.moveTo(50, y + 5).lineTo(545, y + 5).stroke();

    // Totaux
    y += 15;
    doc.fontSize(10).font("Helvetica")
      .text("Sous-total :", 370, y).text(`${order.subtotal} FCFA`, 470, y);
    if ((order.delivery_fee as number) > 0) {
      y += 16;
      doc.text("Livraison :", 370, y).text(`${order.delivery_fee} FCFA`, 470, y);
    }
    y += 16;
    doc.fontSize(11).font("Helvetica-Bold")
      .text("TOTAL :", 370, y).text(`${order.total} FCFA`, 470, y);

    // Pied de page
    doc.fontSize(8).font("Helvetica").text(
      "Merci pour votre confiance — Thank you for your trust",
      50,
      750,
      { align: "center", width: 495 }
    );

    doc.end();
  });
}
