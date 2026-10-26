/** Just enough of `cloudflare:workers` for the Worker's modules to load in Node. */
export class WorkerEntrypoint {}

export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
