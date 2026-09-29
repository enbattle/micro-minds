// The fake CLI's environment (providers/fake/cli.ts), parsed here because only config modules read
// process.env. Missing or invalid values leave the CLI in echo-only mode (it fails open).
import { z } from 'zod';

export interface FakeCliEnv {
  url: string;
  sessionId: string;
  token: string;
}

const schema = z.object({
  MICROMINDS_URL: z.url({ protocol: /^https?$/ }),
  MICROMINDS_SESSION_ID: z.string().min(1),
  MICROMINDS_HOOK_TOKEN: z.string().min(1),
});

/** The hook target, or undefined when any variable is missing or invalid. */
export function readFakeCliEnv(env: NodeJS.ProcessEnv = process.env): FakeCliEnv | undefined {
  const parsed = schema.safeParse(env);
  if (!parsed.success) return undefined;
  return {
    url: parsed.data.MICROMINDS_URL,
    sessionId: parsed.data.MICROMINDS_SESSION_ID,
    token: parsed.data.MICROMINDS_HOOK_TOKEN,
  };
}
