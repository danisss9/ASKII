import { Ollama } from 'ollama';
import { LMStudioClient } from '@lmstudio/sdk';

export async function getOllamaResponse(
  prompt: string,
  url: string,
  model: string,
  system?: string,
  images?: string[],
): Promise<string> {
  const ollama = new Ollama({ host: url });
  const response = await ollama.generate({ model, system, prompt, stream: false, images });
  return response.response || 'No response';
}

export async function getLMStudioResponse(
  prompt: string,
  url: string,
  model: string,
  system?: string,
  imageBase64?: string,
): Promise<string> {
  try {
    const client = new LMStudioClient({ baseUrl: url });
    const llmModel = await client.llm.model(model);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userContent: any = imageBase64
      ? [
          { type: 'imageUrl', url: `data:image/png;base64,${imageBase64}` },
          { type: 'text', text: prompt },
        ]
      : prompt;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = system
      ? [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ]
      : [{ role: 'user', content: userContent }];
    const result = await llmModel.respond(messages);
    return result.content || 'No response';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
}
