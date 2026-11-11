// The omp providers whose models go on a featured vendor card of Models & providers (Anthropic, OpenAI, DeepSeek,
// Google, OpenRouter) — a maker's own API or a sign-in into it. Every other provider omp is signed in to gets a card of
// its own there. The server's model list (server/agents/models.ts) files models by the same table.
import type { Vendor } from './protocol';

export const PROVIDER_VENDOR: Readonly<Record<string, Vendor>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai',
  'openai-codex-device': 'openai',
  azure: 'openai',
  deepseek: 'deepseek',
  google: 'google',
  'google-gemini-cli': 'google',
  'google-antigravity': 'google',
  'google-vertex': 'google',
  openrouter: 'openrouter',
};

/** The provider has a featured vendor card (its models and accounts show there). */
export const featuredProvider = (provider: string): boolean => Object.hasOwn(PROVIDER_VENDOR, provider);
