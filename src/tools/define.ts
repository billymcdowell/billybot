import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** Builds the JSON-schema definition the model sees for one tool. */
export const fn = (name: string, description: string, properties: object, required: string[]) =>
  ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  }) as ChatCompletionTool;
