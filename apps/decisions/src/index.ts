import { WorkerEntrypoint } from "cloudflare:workers";
import { privateApp, publicApp } from "./app";
import type { Env } from "./model";
import { maintain } from "./outbox";

export class DecisionsApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(privateApp.fetch(request, this.env, this.ctx));
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> { return Promise.resolve(publicApp.fetch(request, env, ctx)); },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void { ctx.waitUntil(maintain(env)); },
} satisfies ExportedHandler<Env>;
