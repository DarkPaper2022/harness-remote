import type { MachineAgentHost } from "./types"

/**
 * Project the live image capability into the current machine route. The machine snapshot carries
 * static profile capabilities, while the selected Session has a fresher handshake-derived value.
 */
export function routeCurrentNativeSessionAgents(
  available: MachineAgentHost[],
  targetAgentID: string,
  fallbackAgent: MachineAgentHost,
  attachmentsSupported: boolean
): MachineAgentHost[] {
  return available.some((candidate) => candidate.id === targetAgentID)
    ? available.map((candidate) => candidate.id === targetAgentID
      ? { ...candidate, capabilities: { ...candidate.capabilities, attachments: attachmentsSupported } }
      : candidate)
    : [fallbackAgent, ...available.filter((candidate) => candidate.id !== targetAgentID)]
}
