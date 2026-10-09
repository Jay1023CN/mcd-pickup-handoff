import { env } from "cloudflare:workers";
import { createMobileHandler } from "../../../../lib/mobile-api.mjs";

function handle(request: Request) {
  return createMobileHandler(env.DB)(request);
}
export const GET = handle;
export const POST = handle;
