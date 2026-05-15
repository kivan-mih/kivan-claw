export const DEFAULT_LLM_IDLE_TIMEOUT_SECONDS = 120;
// Wall-clock budget for the *first* SSE event from a cloud provider. Falls
// back to the stream-idle timeout once any chunk has arrived. Distinct from
// DEFAULT_LLM_IDLE_TIMEOUT_SECONDS so a completely silent provider is caught
// without waiting the full idle window. Same local-provider exemption applies
// (loopback / private-network / .local hosts return 0 to disable).
export const DEFAULT_LLM_FIRST_BYTE_TIMEOUT_SECONDS = 120;
// Undici headersTimeout for LLM requests — time to receive the complete HTTP
// response headers. Catches silent providers at the TCP layer before the
// SDK ever returns a Stream object (the application-level watchdog only
// arms after that point, so without this the native Undici 5-minute default
// dominates the failure window).
export const DEFAULT_LLM_HEADERS_TIMEOUT_SECONDS = 30;
// Undici bodyTimeout for LLM requests — inactivity timeout between HTTP body
// bytes (resets on every byte received). TCP-layer counterpart to the
// application-level idle watchdog; the two complement each other because
// the application watchdog observes parsed SSE events while this fires on
// raw bytes (catches the case where the TCP socket is silent without any
// keep-alive activity).
export const DEFAULT_LLM_BODY_TIMEOUT_SECONDS = 120;
