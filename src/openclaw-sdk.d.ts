declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginApi = {
    on(
      hook: string,
      handler: (event: any, ctx?: any) => unknown | Promise<unknown>,
      opts?: { priority?: number; timeoutMs?: number },
    ): void;
    pluginConfig?: Record<string, unknown>;
    logger?: {
      info?(msg: string): void;
      warn?(msg: string): void;
      error?(msg: string): void;
    };
  };
  export function definePluginEntry<
    T extends { id: string; name: string; register(api: OpenClawPluginApi): void },
  >(entry: T): T;
}
