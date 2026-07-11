import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  modelCatalog?: {
    providers?: Record<
      string,
      {
        models?: Array<{
          id?: string;
          reasoning?: boolean;
          input?: string[];
          contextWindow?: number;
          contextTokens?: number;
          maxTokens?: number;
          cost?: Record<string, number>;
          compat?: {
            supportsReasoningEffort?: boolean;
            supportedReasoningEfforts?: string[];
          };
        }>;
      }
    >;
  };
  mediaUnderstandingProviderMetadata?: Record<
    string,
    {
      capabilities?: string[];
      defaultModels?: Record<string, string>;
      autoPriority?: Record<string, number>;
    }
  >;
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceLabel?: string;
    choiceHint?: string;
    choiceId?: string;
    deprecatedChoiceIds?: string[];
    groupHint?: string;
  }>;
};

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
};

function manifestComparableWizardFields(choice: {
  choiceId?: string;
  choiceLabel?: string;
  choiceHint?: string;
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
}) {
  return Object.fromEntries(
    Object.entries({
      choiceId: choice.choiceId,
      choiceLabel: choice.choiceLabel,
      choiceHint: choice.choiceHint,
      groupId: choice.groupId,
      groupLabel: choice.groupLabel,
      groupHint: choice.groupHint,
    }).filter(([, value]) => value !== undefined),
  );
}

function providerWizardByKey() {
  const providers = [buildOpenAIProvider(), buildOpenAICodexProviderPlugin()];
  const wizards = new Map<string, Record<string, unknown>>();

  for (const provider of providers) {
    for (const authMethod of provider.auth ?? []) {
      if (authMethod.wizard) {
        wizards.set(`${provider.id}:${authMethod.id}`, authMethod.wizard);
      }
    }
  }

  return wizards;
}

describe("OpenAI plugin manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    expect(packageJson.dependencies?.["@mariozechner/pi-ai"]).toBe("0.73.0");
    expect(packageJson.dependencies?.ws).toBe("^8.20.0");
  });

  it("declares gpt-5.6-sol for the Codex OAuth route", () => {
    const sol = manifest.modelCatalog?.providers?.["openai-codex"]?.models?.find(
      (model) => model.id === "gpt-5.6-sol",
    );

    expect(sol).toMatchObject({
      id: "gpt-5.6-sol",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 372_000,
      contextTokens: 372_000,
      maxTokens: 128_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    });
  });

  it("keeps removed Codex CLI import auth choice as a deprecated browser-login alias", () => {
    const codexBrowserLogin = manifest.providerAuthChoices?.find(
      (choice) => choice.choiceId === "openai-codex",
    );

    expect(codexBrowserLogin?.deprecatedChoiceIds).toContain("openai-codex-import");
  });

  it("keeps Codex media-understanding manifest metadata aligned with runtime audio support", () => {
    expect(manifest.mediaUnderstandingProviderMetadata?.["openai-codex"]).toMatchObject({
      capabilities: ["image", "audio"],
      defaultModels: {
        image: "gpt-5.5",
        audio: "gpt-4o-transcribe",
      },
      autoPriority: {
        image: 20,
        audio: 20,
      },
    });
  });

  it("labels OpenAI API key and Codex auth choices without stale mixed OAuth wording", () => {
    const choices = manifest.providerAuthChoices ?? [];
    const codexBrowserLogin = choices.find((choice) => choice.choiceId === "openai-codex");
    const codexDeviceCode = choices.find(
      (choice) => choice.choiceId === "openai-codex-device-code",
    );
    const apiKey = choices.find(
      (choice) => choice.provider === "openai" && choice.method === "api-key",
    );

    expect(codexBrowserLogin).toMatchObject({
      choiceLabel: "OpenAI Codex Browser Login",
      choiceHint: "Sign in with OpenAI in your browser",
      groupId: "openai-codex",
      groupLabel: "OpenAI Codex",
      groupHint: "ChatGPT/Codex sign-in",
    });
    expect(codexDeviceCode).toMatchObject({
      choiceLabel: "OpenAI Codex Device Pairing",
      choiceHint: "Pair in browser with a device code",
      groupId: "openai-codex",
      groupLabel: "OpenAI Codex",
      groupHint: "ChatGPT/Codex sign-in",
    });
    expect(apiKey).toMatchObject({
      choiceLabel: "OpenAI API Key",
      groupId: "openai",
      groupLabel: "OpenAI",
      groupHint: "Direct API key",
    });
    expect(choices.map((choice) => choice.choiceLabel)).not.toContain(
      "OpenAI Codex (ChatGPT OAuth)",
    );
    expect(choices.map((choice) => choice.groupHint)).not.toContain("Codex OAuth + API key");
    expect(choices.map((choice) => choice.groupHint)).not.toContain("API key or Codex sign-in");
  });

  it("keeps auth choice copy aligned with provider wizard metadata", () => {
    const wizards = providerWizardByKey();

    for (const choice of manifest.providerAuthChoices ?? []) {
      const key = `${choice.provider}:${choice.method}`;

      expect(wizards.get(key), key).toMatchObject(manifestComparableWizardFields(choice));
    }
  });
});
