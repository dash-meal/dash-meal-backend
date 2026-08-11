import { z } from "zod";

export const InitiatePaymentSchema = z.object({
  order_id: z.string().uuid(),
  method: z.enum(["mobile_money", "cash_on_delivery", "wallet"]),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/).optional(), // requis pour mobile_money
});

export const RecordInPersonPaymentSchema = z.object({
  order_id: z.string().uuid(),
  amount: z.number().positive(),
  reference: z.string().optional(),
});

export type InitiatePaymentInput = z.infer<typeof InitiatePaymentSchema>;
export type RecordInPersonPaymentInput = z.infer<typeof RecordInPersonPaymentSchema>;
