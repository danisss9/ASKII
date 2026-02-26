import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import { LMStudioClient } from '@lmstudio/sdk';

// --- Inline explanation functions (used by decorations) ---

export async function getLLMExplanation(
  lineText: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';
  const mode = config.get<string>('inlineHelperMode') || 'funny';

  if (mode === 'off') {
    return '';
  }

  const isHelpful = mode === 'helpful';

  try {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    if (platform === 'copilot') {
      return await getCopilotExplanation(lineText, isHelpful, abortSignal);
    } else if (platform === 'lmstudio') {
      return await getLMStudioExplanation(lineText, isHelpful, abortSignal);
    } else {
      return await getOllamaExplanation(lineText, isHelpful, abortSignal);
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}

async function getCopilotExplanation(
  lineText: string,
  isHelpful: boolean,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const copilotModel = config.get<string>('copilotModel') || 'gpt-4o';

  try {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: copilotModel });

    if (models.length === 0) {
      return 'Error: GitHub Copilot not available';
    }

    const model = models[0];

    const systemPrompt = isHelpful
      ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
      : 'You are ASKII, a witty coding assistant. Provide humorous comments.';

    const userPrompt = isHelpful
      ? `Explain this code in one sentence: ${lineText}`
      : `Make a funny comment about this code in one sentence: ${lineText}`;

    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];

    const chatResponse = await model.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token,
    );

    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    let responseText = '';
    for await (const fragment of chatResponse.text) {
      responseText += fragment;
    }

    return responseText || 'No explanation available.';
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}

async function getOllamaExplanation(
  lineText: string,
  isHelpful: boolean,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const llmUrl = config.get<string>('llmUrl') || 'http://localhost:11434';
  const ollamaModel = config.get<string>('ollamaModel') || 'gemma3:270m';

  try {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    const ollama = new Ollama({ host: llmUrl });

    const systemPrompt = isHelpful
      ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
      : 'You are ASKII, a witty coding assistant. Provide humorous comments.';

    const userPrompt = isHelpful
      ? `Explain this code in one sentence: ${lineText}`
      : `Make a funny comment about this code in one sentence: ${lineText}`;

    const response = await ollama.generate({
      model: ollamaModel,
      system: systemPrompt,
      prompt: userPrompt,
      stream: false,
    });

    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    return response.response || 'No explanation available.';
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}

async function getLMStudioExplanation(
  lineText: string,
  isHelpful: boolean,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const lmStudioModel = config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
  const llmUrl = config.get<string>('llmUrl') || 'ws://localhost:1234';

  try {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    const systemPrompt = isHelpful
      ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
      : 'You are ASKII, a witty coding assistant. Provide humorous comments.';

    const userPrompt = isHelpful
      ? `Explain this code in one sentence: ${lineText}`
      : `Make a funny comment about this code in one sentence: ${lineText}`;

    const client = new LMStudioClient({ baseUrl: llmUrl });
    const model = await client.llm.model(lmStudioModel);
    const result = await model.respond([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    return result.content || 'No explanation available.';
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}

// --- General response functions (used by commands) ---

export async function getOllamaResponse(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const llmUrl = config.get<string>('llmUrl') || 'http://localhost:11434';
  const ollamaModel = config.get<string>('ollamaModel') || 'gemma3:270m';

  const ollama = new Ollama({ host: llmUrl });
  const response = await ollama.generate({ model: ollamaModel, prompt, stream: false });
  return response.response || 'No response';
}

export async function getCopilotResponse(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const copilotModel = config.get<string>('copilotModel') || 'gpt-4o';

  const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: copilotModel });

  if (models.length === 0) {
    throw new Error('GitHub Copilot not available');
  }

  const model = models[0];
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const chatResponse = await model.sendRequest(
    messages,
    {},
    new vscode.CancellationTokenSource().token,
  );

  let responseText = '';
  for await (const fragment of chatResponse.text) {
    responseText += fragment;
  }
  return responseText;
}

export async function getLMStudioResponse(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const lmStudioModel = config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
  const llmUrl = config.get<string>('llmUrl') || 'ws://localhost:1234';

  try {
    const client = new LMStudioClient({ baseUrl: llmUrl });
    const model = await client.llm.model(lmStudioModel);
    const result = await model.respond(prompt);
    return result.content || 'No response';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
}
