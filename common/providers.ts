import { Ollama } from 'ollama';
import { type ChatMessageInput, LMStudioClient } from '@lmstudio/sdk';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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

export async function getOllamaResponseStreaming(
  prompt: string,
  url: string,
  model: string,
  onChunk: (chunk: string) => void,
  system?: string,
  images?: string[],
): Promise<void> {
  const ollama = new Ollama({ host: url });
  const stream = await ollama.generate({ model, system, prompt, stream: true, images });
  for await (const chunk of stream) {
    if (chunk.response) onChunk(chunk.response);
  }
}

export async function getOllamaChat(
  messages: ChatMessage[],
  url: string,
  model: string,
): Promise<string> {
  const ollama = new Ollama({ host: url });
  const response = await ollama.chat({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
  });
  return response.message.content || 'No response';
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
    const userMessage: ChatMessageInput = { role: 'user', content: prompt };
    if (imageBase64) {
      const fileHandle = await client.files.prepareImageBase64('screenshot.png', imageBase64);
      userMessage.images = [fileHandle];
    }
    const messages: ChatMessageInput[] = system
      ? [{ role: 'system', content: system }, userMessage]
      : [userMessage];
    const result = await llmModel.respond(messages);
    return result.content || 'No response';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
}

export async function getLMStudioChat(
  messages: ChatMessage[],
  url: string,
  model: string,
): Promise<string> {
  try {
    const client = new LMStudioClient({ baseUrl: url });
    const llmModel = await client.llm.model(model);
    const lmsMessages: ChatMessageInput[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const result = await llmModel.respond(lmsMessages);
    return result.content || 'No response';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
}
