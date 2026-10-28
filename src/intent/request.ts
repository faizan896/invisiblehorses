import {z} from 'zod';
import {PaymentIntentV2Schema} from './routing.js';
import {PaymentIntentSchema} from './schema.js';
/** Shared wire contract, independent of server, wallet and database implementation. */
export const RequestSchema=z.union([PaymentIntentV2Schema,PaymentIntentSchema]);
