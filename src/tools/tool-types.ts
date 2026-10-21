import { z } from 'zod';

/**
 * One entry in the tool catalogue. Lives here rather than in index.ts so the
 * catalogue module can be typed without importing the class that consumes it.
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<any>;
}
