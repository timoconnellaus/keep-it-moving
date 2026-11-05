// The parts of Orca's plugin API this plugin uses, written out because
// `orca plugin types` can't find its typings in some Orca builds. Orca's
// own typings, when present in .orca/types, describe the same calls.
declare module "orca" {
  // Filled in by src/protocol.ts.
  interface PluginRequests {}
  interface PluginPanelEvents {}
}

declare module "orca/worker" {
  import type { PluginPanelEvents, PluginRequests } from "orca";
  type Disposable = { dispose(): void };
  type Input<K extends keyof PluginRequests> = PluginRequests[K] extends {
    input: infer I;
  }
    ? I
    : undefined;
  type Output<K extends keyof PluginRequests> = PluginRequests[K] extends {
    output: infer O;
  }
    ? O
    : unknown;
  export interface OrcaWorkerApi {
    host: {
      call(method: string, params?: Record<string, unknown>): Promise<any>;
      has(method: string): boolean;
    };
    commands: { register(id: string, run: () => unknown): Disposable };
    events: { on(event: string, handler: (payload: any) => void): Disposable };
    panels: {
      handle<K extends keyof PluginRequests>(
        name: K,
        handler: (input: Input<K>) => Promise<Output<K>> | Output<K>,
      ): Disposable;
      post<K extends keyof PluginPanelEvents>(
        name: K,
        payload: PluginPanelEvents[K],
      ): void;
    };
    storage: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
    };
    settings: { get(key?: string): Promise<any> };
    log(message: string): void;
    grantedCapabilities: readonly string[];
  }
}
