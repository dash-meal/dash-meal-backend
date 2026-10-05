import { z } from "zod";

export const CreateBrandSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(1000).optional(),
  logo_url: z.string().url().optional(),
  cover_image_url: z.string().url().optional(),
});

export type CreateBrandInput = z.infer<typeof CreateBrandSchema>;

export const BrandApplicationSchema = z.object({
  brand_name: z.string().min(2).max(200),
  contact_email: z.string().email(),
  contact_phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
});

export const ReviewApplicationSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  rejection_reason: z.string().max(1000).optional(),
});

export const BRANCH_TYPES = ["supermarket", "superette", "restaurant", "cafe", "bakery", "pharmacy", "other"] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

const DayScheduleSchema = z.object({
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/),
  enabled: z.boolean().default(true),
});

const OpeningHoursSchema = z.object({
  slot_duration: z.number().int().min(15).max(120).default(30),
  slot_capacity: z.number().int().min(1).max(100).default(5),
  days: z.object({
    monday:    DayScheduleSchema,
    tuesday:   DayScheduleSchema,
    wednesday: DayScheduleSchema,
    thursday:  DayScheduleSchema,
    friday:    DayScheduleSchema,
    saturday:  DayScheduleSchema,
    sunday:    DayScheduleSchema,
  }).optional(),
});

export const CreateBranchSchema = z.object({
  name: z.string().min(2).max(200),
  address: z.string().min(5).max(500),
  city: z.string().min(2).max(100),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  phone: z.string().optional(),
  type: z.string().min(2).max(50).default("other"),
  vertical_id: z.string().uuid().optional(),
  opening_hours: OpeningHoursSchema.optional(),
});

export const UpdateBranchSchema = CreateBranchSchema.partial();

// ─── Branch verticals (profils de stock gérés par le superadmin) ─────────────

export const CreateBranchVerticalSchema = z.object({
  key: z.string().min(2).max(50).regex(/^[a-z0-9_]+$/, "Utiliser des minuscules, chiffres et underscores uniquement"),
  name_fr: z.string().min(2).max(100),
  name_en: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  decrement_on_order: z.boolean().default(true),
  requires_barcode: z.boolean().default(false),
  requires_unit_type: z.boolean().default(false),
  low_stock_default_threshold: z.number().int().min(0).max(1000).default(5),
});

export const UpdateBranchVerticalSchema = CreateBranchVerticalSchema.omit({ key: true }).partial();

export type CreateBranchVerticalInput = z.infer<typeof CreateBranchVerticalSchema>;
export type UpdateBranchVerticalInput = z.infer<typeof UpdateBranchVerticalSchema>;

export const CreateDeliveryZoneSchema = z.object({
  branch_id: z.string().uuid(),
  name: z.string().min(2).max(100),
  polygon_coords: z.array(
    z.object({ lat: z.number(), lng: z.number() })
  ).min(3),
  delivery_fee: z.number().min(0),
  min_order: z.number().min(0),
});

export type BrandApplicationInput = z.infer<typeof BrandApplicationSchema>;
export type ReviewApplicationInput = z.infer<typeof ReviewApplicationSchema>;
export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
export type CreateDeliveryZoneInput = z.infer<typeof CreateDeliveryZoneSchema>;
