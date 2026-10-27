export type ModelInfo = {
  id: string; // what you send to the API, e.g. "anthropic/claude-sonnet-5.5"
  name: string; // display name
  contextLength: number | null;
  inputPerM: number; // USD per million input tokens
  outputPerM: number; // USD per million output tokens
};

// The parts of OpenRouter's response we use.
type ApiModel = {
  id: string;
  name: string;
  context_length: number | null;
  pricing: { prompt: string; completion: string };
};

let cache: ModelInfo[] | null = null;

/** Every OpenRouter model that supports tool calling, most popular first. */
export async function fetchToolModels(apiKey: string, refresh = false): Promise<ModelInfo[]> {
  if (cache && !refresh) return cache;
  const res = await fetch(
    "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular",
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res.ok) throw new Error(`Couldn't load models (HTTP ${res.status})`);
  const body: { data: ApiModel[] } = await res.json();
  cache = body.data.map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.context_length,
    // OpenRouter prices are USD per token, as strings
    inputPerM: Number(m.pricing.prompt) * 1_000_000,
    outputPerM: Number(m.pricing.completion) * 1_000_000,
  }));
  return cache;
}

const money = (n: number) => `$${n < 1 ? n.toFixed(2) : Number(n.toFixed(2))}`;

export function formatPrice(m: ModelInfo): string {
  if (m.inputPerM < 0 || m.outputPerM < 0) return "price varies"; // routers like openrouter/auto
  if (m.inputPerM === 0 && m.outputPerM === 0) return "free";
  return `${money(m.inputPerM)} in / ${money(m.outputPerM)} out per M`;
}

export function formatContext(n: number | null): string {
  if (!n) return "";
  return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M ctx` : `${Math.round(n / 1000)}K ctx`;
}
