// Fake Store + Bus for the city dev harness: two projects (A-N3 house, C-E1 cottage), one busy, one awaiting approval.
import type { AgentInfo, ApprovalRequest, CityState, ClientMsg, Project, ServerMsg } from '../../shared/protocol';
import { LOTS } from '../../shared/city-layout';
import type { Bus, BusEvents, ClientState, Store } from '../src/core/types';

export function createFakeBus(log = true): Bus {
  const subs = new Map<string, Set<(p: unknown) => void>>();
  return {
    on(k, fn) {
      if (!subs.has(k)) subs.set(k, new Set());
      subs.get(k)!.add(fn as (p: unknown) => void);
      return () => subs.get(k)!.delete(fn as (p: unknown) => void);
    },
    emit<K extends keyof BusEvents>(k: K, p: BusEvents[K]) {
      if (log) console.log('[bus]', k, JSON.stringify(p));
      subs.get(k)?.forEach((fn) => fn(p));
    },
  };
}

const projects: Project[] = [
  {
    id: 'p-todo', name: 'todo-api', path: '/home/you/CAST/todo-api', lotId: 'A-N3', style: 'house',
    isGit: true, workflowId: 'decode-implement-review', approvalMode: 'write', createdAt: Date.now() - 86400e3,
  },
  {
    id: 'p-novel', name: 'moonlight-novel', path: '/home/you/CAST/moonlight-novel', lotId: 'C-E1', style: 'cottage',
    isGit: true, workflowId: 'novel', approvalMode: 'write', createdAt: Date.now() - 3600e3,
  },
  {
    id: 'p-api', name: 'payments-service', path: '/home/you/CAST/payments-service', lotId: 'A-S2', style: 'office',
    isGit: true, workflowId: null, approvalMode: 'write', createdAt: Date.now() - 7200e3,
  },
  {
    id: 'p-art', name: 'pixel-studio', path: '/home/you/CAST/pixel-studio', lotId: 'N-2', style: 'studio',
    isGit: false, workflowId: null, approvalMode: 'write', createdAt: Date.now() - 9000e3,
  },
];

function agent(projectId: string, roleId: string, name: string, vendor: AgentInfo['vendor'], status: AgentInfo['status'], activity: AgentInfo['activity']): AgentInfo {
  return {
    id: `${projectId}:${roleId}`, projectId, kind: 'role', name, roleId, model: 'x', modelLabel: name, vendor, demo: false,
    status, activity, appearance: { seed: 1, gender: 'f' },
  };
}

export function createFakeStore(): Store {
  const city: CityState = { lots: LOTS, projects };
  const agents: Record<string, AgentInfo> = {};
  for (const a of [
    agent('p-todo', 'assistant', 'Assistant', 'anthropic', 'busy', 'writing'),
    agent('p-todo', 'decoder', 'Decoder', 'anthropic', 'idle', 'idle'),
    agent('p-novel', 'writer', 'Writer', 'anthropic', 'busy', 'waiting_approval'),
    agent('p-api', 'assistant', 'Assistant', 'openai', 'busy', 'running'),
    agent('p-api', 'reviewer', 'Reviewer', 'deepseek', 'busy', 'reading'),
    agent('p-art', 'assistant', 'Assistant', 'google', 'idle', 'idle'),
  ]) agents[a.id] = a;
  const approvals: Record<string, ApprovalRequest> = {
    'ap-1': {
      id: 'ap-1', agentId: 'p-novel:writer', projectId: 'p-novel', tool: 'bash', title: 'Allow tool: bash',
      detail: 'git diff --stat', options: ['Approve', 'Deny'], ts: Date.now(),
    },
  };
  const state: ClientState = {
    connected: true, hello: null, city, agents, transcripts: {}, workflows: [], runs: {}, approvals,
    models: [], providers: [], git: {}, view: 'city', currentProjectId: null,
  };
  const subs = new Set<(s: ClientState, msg?: ServerMsg) => void>();
  return {
    state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    send(msg: ClientMsg) {
      console.log('[store] send', msg.t);
    },
    async request<T>(msg: ClientMsg & { reqId: string }) {
      console.log('[store] request', msg.t);
      return { ok: true } as T;
    },
    setLocal(patch) {
      Object.assign(state, patch);
      subs.forEach((fn) => fn(state));
    },
    project(id) {
      return id ? state.city.projects.find((p) => p.id === id) : undefined;
    },
    agentsOf(projectId) {
      return Object.values(state.agents).filter((a) => a.projectId === projectId);
    },
  };
}
