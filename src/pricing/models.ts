/**
 * Default per-request pricing for common OpenAI-compatible models.
 * Prices are in USD (same format as route `price` fields, e.g. "$0.01").
 *
 * Users can override or extend these via the `models` field on an
 * `openai-compatible` route.
 */
export const DEFAULT_MODEL_PRICES: Record<string, string> = {
	// OpenAI — flagship
	"gpt-4o": "$0.01",
	"gpt-4o-mini": "$0.001",
	"gpt-4-turbo": "$0.03",
	"gpt-4": "$0.06",
	"gpt-3.5-turbo": "$0.002",
	o1: "$0.06",
	"o1-mini": "$0.012",
	"o1-pro": "$0.60",
	o3: "$0.10",
	"o3-mini": "$0.012",
	"o4-mini": "$0.012",

	// Anthropic (commonly served via OpenAI-compatible proxies)
	"claude-opus-4-5-20250514": "$0.075",
	"claude-sonnet-4-5-20250514": "$0.015",
	"claude-haiku-3-5-20241022": "$0.004",

	// Google Gemini (via OpenRouter / LiteLLM)
	"gemini-2.5-pro": "$0.015",
	"gemini-2.5-flash": "$0.003",
	"gemini-2.0-flash": "$0.001",

	// Meta Llama (via Groq, Together, etc.)
	"llama-3.3-70b": "$0.003",
	"llama-3.1-405b": "$0.015",
	"llama-3.1-70b": "$0.003",
	"llama-3.1-8b": "$0.0005",

	// Mistral
	"mistral-large-latest": "$0.008",
	"mistral-small-latest": "$0.002",

	// DeepSeek
	"deepseek-chat": "$0.002",
	"deepseek-reasoner": "$0.008",
};
