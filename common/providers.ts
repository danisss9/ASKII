import { Ollama } from 'ollama';
import { LMStudioClient } from '@lmstudio/sdk';

export async function getOllamaResponse(
  prompt: string,
  url: string,
  model: string,
  system?: string,
): Promise<string> {
  const ollama = new Ollama({ host: url });
  const response = await ollama.generate({ model, system, prompt, stream: false });
  return response.response || 'No response';
}

export async function getLMStudioResponse(
  prompt: string,
  url: string,
  model: string,
  system?: string,
): Promise<string> {
  try {
    const client = new LMStudioClient({ baseUrl: url });
    const llmModel = await client.llm.model(model);
    const messages: { role: 'system' | 'user'; content: string }[] = system
      ? [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ]
      : [{ role: 'user', content: prompt }];
    const result = await llmModel.respond(messages);
    return result.content || 'No response';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
}
