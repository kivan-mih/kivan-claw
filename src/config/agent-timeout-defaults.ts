export const DEFAULT_LLM_IDLE_TIMEOUT_SECONDS = 1200;
// Wall-clock budget for the *first* chunk from a cloud provider. Falls back
// to the stream-idle timeout once any chunk has arrived. Distinct from
// DEFAULT_LLM_IDLE_TIMEOUT_SECONDS so a completely silent provider is caught
// in ~90s instead of waiting the full 20-minute idle window. Same
// local-provider exemption applies (loopback / private-network / .local hosts
// return 0 to disable).
export const DEFAULT_LLM_FIRST_BYTE_TIMEOUT_SECONDS = 90;
