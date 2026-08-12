import { ChatOpenAI } from "@langchain/openai";
import { CONFIG } from "../config";

export function getLLM() {
    const provider = (CONFIG.llmProvider || "nvidia").toLowerCase();
    if (provider === "ollama") {
        return new ChatOpenAI({
            apiKey: "ollama",
            model: CONFIG.ollamaModel,
            temperature: 0.2,
            configuration: { baseURL: `${CONFIG.ollamaBaseUrl}/v1` },
        });
    } else if (provider === "vllm") {
        return new ChatOpenAI({
            apiKey: "vllm",
            model: CONFIG.vllmModel,
            temperature: 0.2,
            configuration: { baseURL: `${CONFIG.vllmBaseUrl}/v1` },
        });
    } else if (provider === "openai") {
        return new ChatOpenAI({
            apiKey: process.env.OPENAI_API_KEY || "dummy-key",
            model: process.env.OPENAI_MODEL || "gpt-4o",
            temperature: 0.2,
        });
    } else {
        // Default: NVIDIA
        if (!CONFIG.nvidiaApiKey) {
            if (process.env.OPENAI_API_KEY) {
                return new ChatOpenAI({
                    apiKey: process.env.OPENAI_API_KEY,
                    model: process.env.OPENAI_MODEL || "gpt-4o",
                    temperature: 0.2,
                });
            }
            // Fail soft or fallback to dummy if we need a client (e.g., in testing)
            return new ChatOpenAI({
                apiKey: "dummy-key",
                model: "dummy-model",
                temperature: 0.2,
            });
        }
        return new ChatOpenAI({
            apiKey: CONFIG.nvidiaApiKey,
            model: CONFIG.nvidiaModel,
            temperature: 0.2,
            configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
        });
    }
}
