import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

declare global {
  // Prevent double install if imported more than once.
  // eslint-disable-next-line no-var
  var __proxyFixInstalled__: boolean | undefined;
}

if (!globalThis.__proxyFixInstalled__) {
  globalThis.__proxyFixInstalled__ = true;

  // docker-compose forwards `${HTTP_PROXY:-}` etc., which become "" when unset
  // on the host. Coerce empty to undefined so EnvHttpProxyAgent falls back to
  // its own env-var reads instead of treating "" as a configured proxy URL.
  const pick = (v?: string) => (v && v.length > 0 ? v : undefined);
  const httpProxy = pick(process.env.HTTP_PROXY ?? process.env.http_proxy);
  const httpsProxy = pick(process.env.HTTPS_PROXY ?? process.env.https_proxy);
  const noProxy = pick(process.env.NO_PROXY ?? process.env.no_proxy);

  const proxyDispatcher = new EnvHttpProxyAgent({
   httpProxy,
   httpsProxy,
   noProxy,
  });

  // Must register via undici's setGlobalDispatcher. Assigning to
  // globalThis[Symbol.for("undici.globalDispatcher.1")] directly leaves the
  // dispatcher without Node's fetch interceptor wiring, and every request
  // fails with `cause: invalid onRequestStart method` before hitting the wire.
  setGlobalDispatcher(proxyDispatcher);

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


