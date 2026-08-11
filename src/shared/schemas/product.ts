import { z } from "zod";

export const CreateProductSchema = z.object({
  branch_id: z.string().uuid(),
  category_id: z.string().uuid().optional(),
  name_fr: z.string().min(1).max(200),
  name_en: z.string().min(1).max(200),
  description_fr: z.string().max(2000).optional(),
  description_en: z.string().max(2000).optional(),
  price: z.number().positive(),
  image_url: z.string().url().optional(),
  is_active: z.boolean().default(true),
  is_hidden: z.boolean().default(false),
});

export const UpdateProductSchema = CreateProductSchema.partial();

export const SetPromoSchema = z.object({
  promo_price: z.number().positive().nullable(),
  promo_ends_at: z.string().datetime().nullable(),
});

export const CreateProductVariantSchema = z.object({
  product_id: z.string().uuid(),
  name_fr: z.string().min(1).max(100),
  name_en: z.string().min(1).max(100),
  price_modifier: z.number(),
  is_active: z.boolean().default(true),
});

export const UpdateStockSchema = z.object({
  branch_id: z.string().uuid(),
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().optional(),
  stock_qty: z.number().int().min(0),
});

export const CreateCategorySchema = z.object({
  name_fr: z.string().min(1).max(100),
  name_en: z.string().min(1).max(100),
  icon: z.string().optional(),
  branch_id: z.string().uuid().optional(),
  sort_order: z.number().int().min(0).default(0),
});

export const ProductSearchSchema = z.object({
  q: z.string().optional(),
  category_id: z.string().uuid().optional(),
  branch_id: z.string().uuid(),
  min_price: z.number().positive().optional(),
  max_price: z.number().positive().optional(),
  in_stock: z.boolean().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(20),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
export type SetPromoInput = z.infer<typeof SetPromoSchema>;
export type CreateProductVariantInput = z.infer<typeof CreateProductVariantSchema>;
export type UpdateStockInput = z.infer<typeof UpdateStockSchema>;
export type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;
export type ProductSearchInput = z.infer<typeof ProductSearchSchema>;
