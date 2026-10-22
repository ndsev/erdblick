import {z} from "zod";

/** Record-backed identity must not collide with inherited JavaScript property names. */
export const viewIdSchema = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .refine((id) => !Object.prototype.hasOwnProperty.call(Object.prototype, id), "Reserved view ID");

/** Local asynchronous operations capture a lifetime; URLs intentionally carry only the logical ID. */
export const viewIdentitySchema = z.object({id: viewIdSchema, generation: z.number().int().positive()});

/** Logical view identity shared by durable state, links, and live renderer targets. */
export type ViewId = string;

/** A restored logical ID receives a new generation after its previous renderer lifetime ended. */
export interface ViewIdentity {
    id: ViewId;
    generation: number;
}
