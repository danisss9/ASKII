import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceAction {
  type: 'view' | 'create' | 'modify' | 'delete';
  path: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
}

export async function getWorkspaceStructure(dirPath: string, prefix = ''): Promise<string> {
  let structure = '';
  try {
    const files = fs.readdirSync(dirPath);
    const filtered = files.filter(
      (f: string) => !f.startsWith('.') && f !== 'node_modules' && f !== 'dist',
    );

    for (const file of filtered.slice(0, 50)) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      structure += `${prefix}${file}${stat.isDirectory() ? '/' : ''}\n`;

      if (stat.isDirectory() && prefix.length < 6) {
        structure += await getWorkspaceStructure(filePath, prefix + '  ');
      }
    }
  } catch (_) {
    // Ignore errors
  }
  return structure;
}

export function parseWorkspaceActions(responseText: string): WorkspaceAction[] {
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }

    const actions = JSON.parse(jsonMatch[0]) as WorkspaceAction[];

    if (!Array.isArray(actions)) {
      throw new Error('Response is not an array');
    }

    return actions.filter((action) => {
      if (!action.type || !action.path) {
        return false;
      }
      return ['view', 'create', 'modify', 'delete'].includes(action.type);
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to parse workspace actions:', errorMsg);
    return [];
  }
}
