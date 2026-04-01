import { NativeAPIRuntime } from "./runtime.js";
import type { AgentConfig, DispatchInput, DispatchOutput } from "./types.js";
import { TOKEN_BUDGETS, MAX_ITERATIONS } from "./types.js";
import { PromptBuilder } from "../prompt/prompt-builder.js";
import { identitySection, taskSection } from "../prompt/sections.js";
import type { PromptContext } from "../prompt/types.js";

interface VerificationResult {
  verdict: "PASS" | "FAIL" | "PARTIAL";
  confidence: "high" | "medium" | "low";
  issues: string[];
  summary: string;
}

export class VerificationAgent {
  private toolExecutor: (name: string, input: unknown) => Promise<unknown>;

  constructor(deps: { toolExecutor: (name: string, input: unknown) => Promise<unknown> }) {
    this.toolExecutor = deps.toolExecutor;
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const runtime = new NativeAPIRuntime(apiKey);
    runtime.setToolExecutor(this.toolExecutor);

    const config: AgentConfig = {
      agentType: "verification",
      model: "claude-haiku-4-5",
      system: this.buildSystemPrompt(input),
      tools: [],
      tokenBudget: TOKEN_BUDGETS.verification,
      maxIterations: MAX_ITERATIONS.verification,
    };

    const result = await runtime.run(config, input.task);

    let verification: VerificationResult;
    try {
      verification = JSON.parse(result.text);
    } catch {
      verification = {
        verdict: "PARTIAL",
        confidence: "low",
        issues: ["Could not parse verification result"],
        summary: result.text,
      };
    }

    const output: DispatchOutput = {
      result: `[${verification.verdict}] ${verification.summary}`,
      toolCallCount: result.toolCalls.length,
      tokensUsed: result.tokensUsed.input + result.tokensUsed.output,
    };

    if (verification.verdict === "FAIL") {
      output.needsAssistance = {
        agentType: "master",
        task: verification.issues.join("; "),
        context: verification,
      };
    }

    return output;
  }

  buildSystemPrompt(input: DispatchInput): string {
    const builder = new PromptBuilder({ builtins: false });
    builder.register(identitySection);
    builder.register(taskSection);
    const promptCtx: PromptContext = {
      agentIdentity: {
        role: "Verification Agent",
        description: "You are an adversarial verifier. Your job is to check whether an edit or generation result matches the user's original intent.",
        rules: [
          "Compare the reported result against the user's intent.",
          "Check for: wrong elements affected, incorrect values, missing changes, unintended side effects.",
          "Be skeptical — assume the edit might be wrong until proven correct.",
          'Output ONLY a JSON object with this schema: { "verdict": "PASS" | "FAIL" | "PARTIAL", "confidence": "high" | "medium" | "low", "issues": string[], "summary": string }',
        ],
      },
      task: input,
    };
    return builder.build(promptCtx);
  }
}
