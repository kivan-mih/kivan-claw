import { bootstrap } from "global-agent";
import { EnvHttpProxyAgent } from "undici";

declare global {
  // Prevent double install if imported more than once.
  // eslint-disable-next-line no-var
  var __proxyFixInstalled__: boolean | undefined;
}

if (!globalThis.__proxyFixInstalled__) {
  globalThis.__proxyFixInstalled__ = true;

  // Legacy node:http / node:https clients
  bootstrap();

  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;

  const proxyDispatcher = new EnvHttpProxyAgent({
   httpProxy,
   httpsProxy,
   noProxy,
  });

  // Native fetch in modern Node/Undici reads the global dispatcher from this symbol.
  // Using the symbol directly is the least fragile path across bundled/internal Undici copies.
  const globalDispatcherSymbol = Symbol.for("undici.globalDispatcher.1");
  (globalThis as any)[globalDispatcherSymbol] = proxyDispatcher;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (
   input: RequestInfo | URL,
   init?: RequestInit,
  ) => {
   try {
    // IMPORTANT:
    // Do not inject init.dispatcher here.
    // Newer Undici/native fetch paths may pass internal request handlers/options,
    // and forcing dispatcher per-call can corrupt the dispatch contract.
    return await originalFetch(input as any, init);
   } catch (err: any) {
    const hiddenCause = err?.cause;

    if (hiddenCause) {
     let url = "<unknown>";

     try {
      if (typeof input === "string") {
       url = input;
      } else if (input instanceof URL) {
       url = input.toString();
      } else if (
       typeof Request !== "undefined" &&
       input instanceof Request
      ) {
       url = input.url;
      }
     } catch {
      // ignore
     }

     console.error("\n🚨 --- INTERCEPTED NATIVE FETCH ERROR --- 🚨");
     console.error("URL Attempted :", url);
     console.error("Hidden Cause :", hiddenCause);
     console.error("🚨 ---------------------------------------- 🚨\n");
    }

    throw err;
   }
  };
}

export {};
