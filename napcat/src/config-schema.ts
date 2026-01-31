import { BlockStreamingCoalesceSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const NapcatAccountConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  url: z.string().trim().url().optional(),
  cliPath: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  ignorePrefixes: z.array(z.string().min(1)).optional(),
  fromGroup: z.union([z.string(), z.number()]).optional(),
  fromUser: z.union([z.string(), z.number()]).optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
});

export const NapcatConfigSchema = NapcatAccountConfigSchema.extend({
  accounts: z.record(NapcatAccountConfigSchema).optional(),
});

export const napcatChannelConfigSchema = buildChannelConfigSchema(NapcatConfigSchema);
